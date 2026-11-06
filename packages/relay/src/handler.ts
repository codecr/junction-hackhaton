import { timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import {
  MEMBER_ID_PATTERN,
  SQUAD_ID_PATTERN,
  fromBase64Url,
  memberIdFromPublicKey,
  openCharter,
  openMessage,
  parseInstant,
  sha256Bytes,
  sha256Hex,
  utf8,
  verifyRequest,
  type Charter,
  type Envelope,
  type SignedAuth,
} from '@junction/core';
import { DynamoStore, queryAll, type SquadStore } from './store';

// The squad server: a mailbox for signed envelopes (docs/02, docs/03 "Squad server API").
// It verifies request signatures against the leader-signed charter, records nonces, validates
// envelopes with core, and stores only the envelope as received (CLAUDE.md rule 2). It never logs
// bodies or headers and never calls the Events API.

export const MAX_BODY_BYTES = 64 * 1024;
export const NONCE_TTL_SEC = 600;
/** A charter may not live longer than this from the time it is stored. */
export const MAX_CHARTER_LIFETIME_SEC = 400 * 24 * 3600;
export const MAX_PENDING_JOINS = 50;
export const SIGNAL_PAGE = 100;

export interface LogEntry {
  route: string;
  status: number;
  squadId?: string;
}

export interface RelayDeps {
  store: SquadStore;
  /** Epoch milliseconds. */
  now: () => number;
  log?: (entry: LogEntry) => void;
}

/** The parts of an API Gateway HTTP API (payload v2) event the router reads. */
export interface RelayEvent {
  rawPath: string;
  body?: string | undefined;
  isBase64Encoded?: boolean | undefined;
  headers?: Record<string, string | undefined> | undefined;
  queryStringParameters?: Record<string, string | undefined> | undefined;
  requestContext: { http: { method: string } };
}

export type RelayResult = APIGatewayProxyStructuredResultV2 & {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): RelayResult {
  return {
    statusCode: status,
    headers: { ...JSON_HEADERS, ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

interface Ctx {
  method: string;
  path: string;
  body: string;
  authorization: string | undefined;
  ifNoneMatch: string | undefined;
  query: Record<string, string | undefined>;
  nowSec: number;
  nowIso: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  name: string;
  run: (ctx: Ctx, params: string[]) => Promise<RelayResult>;
}

const ID = '([^/]+)';

function header(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** `{ "sessionId": "<id>" }` and nothing else. */
function parseAnnouncement(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  const { sessionId } = raw as Record<string, unknown>;
  if (keys.length !== 1 || typeof sessionId !== 'string') return undefined;
  if (sessionId.length < 1 || sessionId.length > 128) return undefined;
  return { sessionId };
}

/** `{ publicKey, name, inviteSecret }` and nothing else. The name is plain text, 1 to 40 characters. */
function parseJoinRequest(
  raw: unknown,
): { publicKey: string; name: string; inviteSecret: string } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 3) return undefined;
  const { publicKey, name, inviteSecret } = r;
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return undefined;
  if (typeof name !== 'string' || name.length < 1 || name.length > 40 || /\p{Cc}/u.test(name))
    return undefined;
  if (typeof inviteSecret !== 'string' || inviteSecret.length < 8 || inviteSecret.length > 256)
    return undefined;
  return { publicKey, name, inviteSecret };
}

export function createHandler(deps: RelayDeps): (event: RelayEvent) => Promise<RelayResult> {
  const { store } = deps;
  const log = deps.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));

  // ---- shared steps ---------------------------------------------------------------------------

  function checkSquadId(id: string): string {
    if (!SQUAD_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        'bad-squad-id',
        `"${id.slice(0, 40)}" is not a squad id. Squad ids look like sq_ followed by 16 characters.`,
      );
    }
    return id;
  }

  function checkMemberId(id: string): string {
    if (!MEMBER_ID_PATTERN.test(id)) {
      throw new HttpError(
        400,
        'bad-member-id',
        'That is not a member id. Member ids look like m_ followed by 16 characters.',
      );
    }
    return id;
  }

  function parseJson(ctx: Ctx): unknown {
    try {
      return JSON.parse(ctx.body);
    } catch {
      throw new HttpError(
        400,
        'bad-json',
        'The request body is not valid JSON. Send the signed envelope as JSON.',
      );
    }
  }

  function charterTtl(charter: Charter): number {
    return parseInstant(charter.expiresAt) ?? 0;
  }

  function checkLifetime(charter: Charter, nowSec: number): void {
    const expires = charterTtl(charter);
    if (expires <= nowSec) {
      throw new HttpError(
        400,
        'expired-charter',
        'The charter has already expired. Set expiresAt to the event end plus 14 days and sign it again.',
      );
    }
    if (expires > nowSec + MAX_CHARTER_LIFETIME_SEC) {
      throw new HttpError(
        400,
        'charter-too-long',
        'The charter expires more than 400 days from now. Set expiresAt to the event end plus 14 days.',
      );
    }
  }

  async function loadCharter(
    squadId: string,
    nowSec: number,
  ): Promise<{ charter: Charter; env: Envelope }> {
    const item = await store.get(squadId, 'CHARTER');
    if (!item?.env) {
      throw new HttpError(
        404,
        'no-squad',
        'This squad does not exist on the server. Check the squad id, or ask the leader to publish the squad again.',
      );
    }
    const opened = openCharter(item.env);
    if (!opened.ok) throw new Error('A stored charter failed verification.');
    if (charterTtl(opened.value) <= nowSec) {
      throw new HttpError(
        404,
        'squad-expired',
        'This squad has expired and its data is being deleted.',
      );
    }
    return { charter: opened.value, env: item.env };
  }

  function memberKeyOf(charter: Charter) {
    return (kid: string): Uint8Array | undefined => {
      const m = charter.members.find((x) => x.memberId === kid);
      return m ? fromBase64Url(m.publicKey) : undefined;
    };
  }

  function authenticate(ctx: Ctx, keyOf: (kid: string) => Uint8Array | undefined): SignedAuth {
    if (ctx.authorization && /^\s*bearer\s/i.test(ctx.authorization)) {
      throw new HttpError(
        401,
        'bearer-refused',
        'This server never accepts bearer tokens. Do not send Events API credentials here; sign the request with your Junction member key.',
      );
    }
    const r = verifyRequest(
      { method: ctx.method, path: ctx.path, body: ctx.body },
      ctx.authorization,
      keyOf,
      ctx.nowSec,
    );
    if (r.ok) return r.value;
    switch (r.error) {
      case 'missing':
        throw new HttpError(
          401,
          'unsigned',
          'The request is not signed. Send an Authorization: Junction header signed with your member key.',
        );
      case 'malformed':
        throw new HttpError(
          401,
          'malformed-auth',
          'The Authorization header is malformed. Expected: Junction kid=, ts=, nonce=, sig=.',
        );
      case 'stale':
        throw new HttpError(
          401,
          'stale',
          'The request timestamp is more than 120 seconds away from server time. Check your computer clock and retry.',
        );
      case 'unknown-member':
        throw new HttpError(
          403,
          'not-a-member',
          'The signer is not a member of this squad. Ask the leader to approve your join request.',
        );
      case 'bad-signature':
        throw new HttpError(
          401,
          'bad-signature',
          'The request signature does not match. Retry; if it persists, your member key does not match the charter.',
        );
    }
  }

  async function useNonce(squadId: string, auth: SignedAuth, nowSec: number): Promise<void> {
    const fresh = await store.put(
      squadId,
      { sk: `NONCE#${auth.nonce}`, ttl: nowSec + NONCE_TTL_SEC },
      { kind: 'absent' },
    );
    if (!fresh) {
      throw new HttpError(
        401,
        'replayed',
        'This signed request was already used. Sign a new request with a fresh nonce.',
      );
    }
  }

  /** Load charter, verify the signer is a member (optionally a specific one), record the nonce. */
  async function asMember(
    ctx: Ctx,
    squadId: string,
    allowed?: (kid: string, charter: Charter) => string | undefined,
  ): Promise<{ charter: Charter; env: Envelope; kid: string }> {
    const { charter, env } = await loadCharter(squadId, ctx.nowSec);
    const auth = authenticate(ctx, memberKeyOf(charter));
    const refusal = allowed?.(auth.kid, charter);
    if (refusal) throw new HttpError(403, 'forbidden', refusal);
    await useNonce(squadId, auth, ctx.nowSec);
    return { charter, env, kid: auth.kid };
  }

  const leaderOnly = (what: string) => (kid: string, charter: Charter) =>
    kid === charter.leader ? undefined : `Only the squad leader can ${what}.`;

  function openOrFail(raw: unknown, charter: Charter) {
    const opened = openMessage(raw, charter);
    if (!opened.ok) {
      const status = opened.error.code === 'unknown-signer' ? 403 : 400;
      throw new HttpError(status, opened.error.code, opened.error.message);
    }
    return { message: opened.value, env: raw as Envelope };
  }

  // ---- routes ---------------------------------------------------------------------------------

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/v1\/health$/,
      name: 'GET /v1/health',
      run: async () => respond(200, { ok: true }),
    },
    {
      method: 'POST',
      pattern: /^\/v1\/squads$/,
      name: 'POST /v1/squads',
      run: async (ctx) => {
        const raw = parseJson(ctx);
        const opened = openCharter(raw);
        if (!opened.ok) throw new HttpError(400, opened.error.code, opened.error.message);
        const charter = opened.value;
        const leaderKey = fromBase64Url(
          charter.members.find((m) => m.memberId === charter.leader)!.publicKey,
        );
        const auth = authenticate(ctx, (kid) => (kid === charter.leader ? leaderKey : undefined));
        await useNonce(charter.squadId, auth, ctx.nowSec);
        checkLifetime(charter, ctx.nowSec);
        const created = await store.put(
          charter.squadId,
          {
            sk: 'CHARTER',
            env: raw as Envelope,
            mid: charter.leader,
            seq: charter.seq,
            ttl: charterTtl(charter),
          },
          { kind: 'absent' },
        );
        if (!created) {
          throw new HttpError(
            409,
            'squad-exists',
            'A squad with this id already exists. Publish changes with PUT /v1/squads/{id}/charter instead.',
          );
        }
        return respond(201, { squadId: charter.squadId, seq: charter.seq });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/squads/${ID}$`),
      name: 'GET /v1/squads/{id}',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter, env } = await asMember(ctx, squadId);
        const members = new Set(charter.members.map((m) => m.memberId));
        const manifests = (await queryAll(store, squadId, 'MANIFEST#'))
          .filter((i) => i.env && i.mid && members.has(i.mid))
          .map((i) => i.env!);
        const body = JSON.stringify({ charter: env, manifests });
        const etag = `"${sha256Hex(utf8(body))}"`;
        if (ctx.ifNoneMatch === etag) {
          return { statusCode: 304, headers: { etag, 'cache-control': 'no-store' }, body: '' };
        }
        return { statusCode: 200, headers: { ...JSON_HEADERS, etag }, body };
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/v1/squads/${ID}$`),
      name: 'DELETE /v1/squads/{id}',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        await asMember(ctx, squadId, leaderOnly('delete the squad'));
        // Nonces stay until their TTL so a recorded create request cannot be replayed.
        const items = (await queryAll(store, squadId, '')).filter(
          (i) => !i.sk.startsWith('NONCE#'),
        );
        await store.delete(
          squadId,
          items.map((i) => i.sk),
        );
        return respond(200, { purged: true, items: items.length });
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/v1/squads/${ID}/charter$`),
      name: 'PUT /v1/squads/{id}/charter',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter: previous } = await asMember(
          ctx,
          squadId,
          leaderOnly('change the charter'),
        );
        const raw = parseJson(ctx);
        const opened = openCharter(raw, previous);
        if (!opened.ok) {
          const status = opened.error.code === 'stale' ? 409 : 400;
          throw new HttpError(status, opened.error.code, opened.error.message, {
            storedSeq: previous.seq,
          });
        }
        const charter = opened.value;
        checkLifetime(charter, ctx.nowSec);
        const stored = await store.put(
          squadId,
          {
            sk: 'CHARTER',
            env: raw as Envelope,
            mid: charter.leader,
            seq: charter.seq,
            ttl: charterTtl(charter),
          },
          { kind: 'seq-below', seq: charter.seq },
        );
        if (!stored) {
          throw new HttpError(
            409,
            'stale',
            'A newer charter was stored meanwhile. Fetch the squad and sign again with a higher seq.',
          );
        }
        return respond(200, { squadId, seq: charter.seq });
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/v1/squads/${ID}/members/${ID}/manifest$`),
      name: 'PUT /v1/squads/{id}/members/{mid}/manifest',
      run: async (ctx, [id, rawMid]) => {
        const squadId = checkSquadId(id!);
        const mid = checkMemberId(rawMid!);
        const { charter } = await asMember(ctx, squadId, (kid) =>
          kid === mid ? undefined : 'A member can only publish their own manifest.',
        );
        const { message, env } = openOrFail(parseJson(ctx), charter);
        if (message.type !== 'manifest' || env.kid !== mid) {
          throw new HttpError(
            400,
            'wrong-type',
            'This route takes the manifest signed by the member in the path.',
          );
        }
        const stored = await store.put(
          squadId,
          { sk: `MANIFEST#${mid}`, env, mid, seq: message.seq, ttl: charterTtl(charter) },
          { kind: 'seq-below', seq: message.seq },
        );
        if (!stored) {
          const current = await store.get(squadId, `MANIFEST#${mid}`);
          throw new HttpError(
            409,
            'stale',
            `Manifest seq ${message.seq} is not newer than the stored one. Sign a new manifest with a higher seq.`,
            {
              storedSeq: current?.seq,
            },
          );
        }
        return respond(200, { memberId: mid, seq: message.seq });
      },
    },
    {
      method: 'DELETE',
      pattern: new RegExp(`^/v1/squads/${ID}/members/${ID}$`),
      name: 'DELETE /v1/squads/{id}/members/{mid}',
      run: async (ctx, [id, rawMid]) => {
        const squadId = checkSquadId(id!);
        const mid = checkMemberId(rawMid!);
        await asMember(ctx, squadId, (kid, charter) =>
          kid === mid || kid === charter.leader
            ? undefined
            : 'Only that member or the leader can remove a member’s data.',
        );
        const items = (await queryAll(store, squadId, '')).filter(
          (i) => i.mid === mid && i.sk !== 'CHARTER',
        );
        await store.delete(
          squadId,
          items.map((i) => i.sk),
        );
        return respond(200, { memberId: mid, removed: items.length });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/squads/${ID}/signals$`),
      name: 'POST /v1/squads/{id}/signals',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter, kid } = await asMember(ctx, squadId);
        const { message, env } = openOrFail(parseJson(ctx), charter);
        if (message.type !== 'signal' || env.kid !== kid) {
          throw new HttpError(
            400,
            'wrong-type',
            'This route takes a scout note (signal) signed by the requester.',
          );
        }
        const cursor = `${ctx.nowIso}#${kid}#${message.sessionId}`;
        await store.put(
          squadId,
          { sk: `SIGNAL#${cursor}`, env, mid: kid, at: ctx.nowIso, ttl: charterTtl(charter) },
          { kind: 'none' },
        );
        return respond(201, { cursor });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/squads/${ID}/signals$`),
      name: 'GET /v1/squads/{id}/signals',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        await asMember(ctx, squadId);
        const since = ctx.query['since'];
        if (
          since !== undefined &&
          (since.length > 300 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(since))
        ) {
          throw new HttpError(
            400,
            'bad-since',
            'since must be an ISO instant or the cursor returned by the previous page.',
          );
        }
        const page = await store.query(squadId, 'SIGNAL#', {
          ...(since === undefined ? {} : { after: `SIGNAL#${since}` }),
          limit: SIGNAL_PAGE,
        });
        const signals = page.items
          .filter((i) => i.env)
          .map((i) => ({ envelope: i.env!, receivedAt: i.at }));
        const last = page.items[page.items.length - 1];
        const cursor = last ? last.sk.slice('SIGNAL#'.length) : since;
        return respond(200, {
          signals,
          ...(cursor === undefined ? {} : { cursor }),
          more: page.last !== undefined,
        });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/squads/${ID}/announcements$`),
      name: 'POST /v1/squads/{id}/announcements',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter, kid } = await asMember(ctx, squadId);
        const parsed = parseAnnouncement(parseJson(ctx));
        if (!parsed) {
          throw new HttpError(
            400,
            'bad-announcement',
            'An announcement body is exactly { "sessionId": "<id>" }.',
          );
        }
        const { sessionId } = parsed;
        const sk = `ANNOUNCE#${sessionId}`;
        const first = await store.put(
          squadId,
          { sk, mid: kid, at: ctx.nowIso, ttl: charterTtl(charter) },
          { kind: 'absent' },
        );
        const record = first ? { mid: kid, at: ctx.nowIso } : await store.get(squadId, sk);
        return respond(first ? 201 : 200, {
          sessionId,
          memberId: record?.mid,
          announcedAt: record?.at,
          first,
        });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/squads/${ID}/claims$`),
      name: 'POST /v1/squads/{id}/claims',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter, kid } = await asMember(ctx, squadId);
        const { message, env } = openOrFail(parseJson(ctx), charter);
        if (message.type !== 'claim' || env.kid !== kid) {
          throw new HttpError(
            400,
            'wrong-type',
            'This route takes a claim signed by the requester.',
          );
        }
        const sk = `CLAIM#${message.sessionId}`;
        const won = await store.put(
          squadId,
          { sk, env, mid: kid, at: ctx.nowIso, ttl: charterTtl(charter) },
          { kind: 'absent' },
        );
        if (!won) {
          const winner = await store.get(squadId, sk);
          if (winner?.mid === kid) {
            return respond(200, { sessionId: message.sessionId, winner: kid, claim: winner.env });
          }
          throw new HttpError(
            409,
            'already-claimed',
            'Another member claimed this session first. Remove the proposal for it.',
            {
              sessionId: message.sessionId,
              winner: winner?.mid,
              claim: winner?.env,
            },
          );
        }
        return respond(201, { sessionId: message.sessionId, winner: kid, claim: env });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/squads/${ID}/join-requests$`),
      name: 'POST /v1/squads/{id}/join-requests',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter } = await loadCharter(squadId, ctx.nowSec);
        const parsed = parseJoinRequest(parseJson(ctx));
        if (!parsed) {
          throw new HttpError(
            400,
            'bad-join-request',
            'A join request body is { "publicKey", "name" (1 to 40 characters), "inviteSecret" }.',
          );
        }
        const { publicKey, name, inviteSecret } = parsed;
        const keyBytes = fromBase64Url(publicKey);
        const mid = memberIdFromPublicKey(keyBytes);
        const auth = authenticate(ctx, (kid) => (kid === mid ? keyBytes : undefined));
        await useNonce(squadId, auth, ctx.nowSec);
        const expected = fromBase64Url(charter.inviteVerifier);
        const actual = sha256Bytes(utf8(inviteSecret));
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          throw new HttpError(
            403,
            'bad-invite',
            'The invite secret does not match this squad. Ask the leader for a current invite.',
          );
        }
        if (charter.members.some((m) => m.memberId === mid)) {
          return respond(200, { memberId: mid, status: 'member' });
        }
        const pending = await queryAll(store, squadId, 'JOIN#');
        if (pending.length >= MAX_PENDING_JOINS && !pending.some((p) => p.mid === mid)) {
          throw new HttpError(
            429,
            'too-many-joins',
            'This squad has too many pending join requests. Ask the leader to approve or clear them.',
          );
        }
        await store.put(
          squadId,
          { sk: `JOIN#${mid}`, mid, publicKey, name, at: ctx.nowIso, ttl: charterTtl(charter) },
          { kind: 'none' },
        );
        return respond(202, { memberId: mid, status: 'pending' });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/squads/${ID}/join-requests$`),
      name: 'GET /v1/squads/{id}/join-requests',
      run: async (ctx, [id]) => {
        const squadId = checkSquadId(id!);
        const { charter } = await asMember(ctx, squadId, leaderOnly('see join requests'));
        const members = new Set(charter.members.map((m) => m.memberId));
        const requests = (await queryAll(store, squadId, 'JOIN#'))
          .filter((i) => i.mid && !members.has(i.mid))
          .map((i) => ({
            memberId: i.mid,
            publicKey: i.publicKey,
            name: i.name,
            requestedAt: i.at,
          }));
        return respond(200, { requests });
      },
    },
  ];

  return async (event) => {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;
    let routeName = `${method} unknown`;
    let squadId: string | undefined;
    let result: RelayResult;
    try {
      const candidates = routes.filter((r) => r.pattern.test(path));
      const route = candidates.find((r) => r.method === method);
      if (!route) {
        throw candidates.length > 0
          ? new HttpError(405, 'method-not-allowed', `${method} is not supported on this path.`)
          : new HttpError(
              404,
              'no-route',
              'There is no such route on the squad server. Check the server URL and update Junction.',
            );
      }
      routeName = route.name;
      const params = route.pattern.exec(path)!.slice(1);
      if (route.name.includes('{id}') && params[0] && SQUAD_ID_PATTERN.test(params[0]))
        squadId = params[0];

      const raw = event.body ?? '';
      const bodyBytes = event.isBase64Encoded
        ? Buffer.from(raw, 'base64')
        : Buffer.from(raw, 'utf8');
      if (bodyBytes.length > MAX_BODY_BYTES) {
        throw new HttpError(
          413,
          'too-large',
          'The request body is larger than 64 KB. Manifests and charters are far smaller; check what is being sent.',
        );
      }
      const nowMs = deps.now();
      const ctx: Ctx = {
        method,
        path,
        body: bodyBytes.toString('utf8'),
        authorization: header(event.headers, 'authorization'),
        ifNoneMatch: header(event.headers, 'if-none-match'),
        query: event.queryStringParameters ?? {},
        nowSec: Math.floor(nowMs / 1000),
        nowIso: new Date(nowMs).toISOString(),
      };
      result = await route.run(ctx, params);
    } catch (e) {
      if (e instanceof HttpError) {
        result = respond(e.status, { error: e.code, message: e.message, ...e.extra });
      } else {
        result = respond(500, {
          error: 'internal',
          message:
            'The squad server failed unexpectedly. Retry in a minute; if it keeps failing, exchange files instead.',
        });
        console.error(
          JSON.stringify({
            route: routeName,
            squadId,
            error: e instanceof Error ? e.name : 'unknown',
          }),
        );
      }
    }
    log({
      route: routeName,
      status: result.statusCode,
      ...(squadId === undefined ? {} : { squadId }),
    });
    return result;
  };
}

let lambdaHandler: ((event: RelayEvent) => Promise<RelayResult>) | undefined;

/** Lambda entry point. TABLE_NAME comes from the stack. */
export async function handler(event: APIGatewayProxyEventV2): Promise<RelayResult> {
  if (!lambdaHandler) {
    const table = process.env['TABLE_NAME'];
    if (!table) throw new Error('TABLE_NAME is not set.');
    lambdaHandler = createHandler({ store: new DynamoStore(table), now: () => Date.now() });
  }
  return lambdaHandler(event);
}
