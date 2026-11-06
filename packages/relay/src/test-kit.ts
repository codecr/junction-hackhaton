import {
  keyPairFromSeed,
  memberIdFromPublicKey,
  sha256Bytes,
  signMessage,
  signRequest,
  squadIdFrom,
  toBase64Url,
  utf8,
  type Charter,
  type Envelope,
  type KeyPair,
  type Manifest,
} from '@junction/core';
import { createHandler, type LogEntry, type RelayEvent, type RelayResult } from './handler';
import { MemoryStore } from './store';

// Test-only helpers: deterministic members, signed messages and an in-process fetch.

export const INVITE_SECRET = 'correct-horse-battery';
export const NOW_MS = Date.UTC(2026, 10, 6, 12, 0, 0);

export interface Member {
  name: string;
  keys: KeyPair;
  memberId: string;
}

export function member(name: string, n: number): Member {
  const keys = keyPairFromSeed(new Uint8Array(32).fill(n));
  return { name, keys, memberId: memberIdFromPublicKey(keys.publicKey) };
}

export function charterFor(members: Member[], overrides: Partial<Charter> = {}): Charter {
  const leader = members[0]!;
  return {
    v: 1,
    type: 'charter',
    squadId: squadIdFrom(leader.keys.publicKey, new Uint8Array(16).fill(9)),
    name: 'Test squad',
    eventId: 'reinvent2026',
    leader: leader.memberId,
    seq: 1,
    issuedAt: '2026-11-01T18:00:00Z',
    expiresAt: '2026-12-18T00:00:00Z',
    inviteVerifier: toBase64Url(sha256Bytes(utf8(INVITE_SECRET))),
    members: members.map((m, i) => ({
      memberId: m.memberId,
      name: m.name,
      publicKey: toBase64Url(m.keys.publicKey),
      role: i === 0 ? ('leader' as const) : ('member' as const),
      joinedAt: '2026-11-01T18:00:00Z',
    })),
    topics: [{ id: 'agentic', label: 'Agentic AI', weight: 5, target: 2 }],
    ...overrides,
  };
}

export function signedCharter(members: Member[], overrides: Partial<Charter> = {}): Envelope {
  const c = charterFor(members, overrides);
  return signMessage(c, members[0]!.memberId, members[0]!.keys.secretKey);
}

export function signedManifest(
  m: Member,
  squadId: string,
  overrides: Partial<Manifest> = {},
): Envelope {
  const manifest: Manifest = {
    v: 1,
    type: 'manifest',
    squadId,
    memberId: m.memberId,
    seq: 1,
    issuedAt: '2026-11-05T15:04:05Z',
    eventId: 'reinvent2026',
    catalogHash: `sha256:${'a'.repeat(64)}`,
    share: 'L0',
    sessions: [{ sessionId: 's-1', code: 'AGT301', status: 'reserved' }],
    ...overrides,
  };
  return signMessage(manifest, m.memberId, m.keys.secretKey);
}

export function signedClaim(m: Member, squadId: string, sessionId: string): Envelope {
  return signMessage(
    {
      v: 1,
      type: 'claim',
      squadId,
      memberId: m.memberId,
      sessionId,
      rank: 0,
      issuedAt: '2026-11-06T12:00:00Z',
    },
    m.memberId,
    m.keys.secretKey,
  );
}

export function signedSignal(
  m: Member,
  squadId: string,
  sessionId: string,
  note: string,
): Envelope {
  return signMessage(
    {
      v: 1,
      type: 'signal',
      squadId,
      memberId: m.memberId,
      sessionId,
      code: 'AGT301',
      verdict: 'worth-it',
      note,
      issuedAt: '2026-11-06T12:00:00Z',
    },
    m.memberId,
    m.keys.secretKey,
  );
}

let nonceCounter = 0;
export function nextNonce(): Uint8Array {
  nonceCounter += 1;
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, nonceCounter);
  return bytes;
}

export interface SendOptions {
  headers?: Record<string, string>;
  nonce?: Uint8Array;
  tsMs?: number;
  query?: Record<string, string>;
}

export type Sent = RelayResult & { json: Record<string, unknown> };

export interface Harness {
  store: MemoryStore;
  clock: { ms: number };
  logs: LogEntry[];
  call: (event: RelayEvent) => Promise<RelayResult>;
  /** A request signed by member `m`. */
  send: (
    m: Member,
    method: string,
    path: string,
    body?: unknown,
    opts?: SendOptions,
  ) => Promise<Sent>;
  fetch: typeof fetch;
}

export function harness(): Harness {
  const store = new MemoryStore();
  const clock = { ms: NOW_MS };
  const logs: LogEntry[] = [];
  const call = createHandler({ store, now: () => clock.ms, log: (e) => logs.push(e) });

  const send: Harness['send'] = async (m, method, path, body, opts = {}) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const ts = Math.floor((opts.tsMs ?? clock.ms) / 1000);
    const authorization = signRequest(
      { method, path, body: text },
      m.memberId,
      m.keys.secretKey,
      ts,
      opts.nonce ?? nextNonce(),
    );
    const res = await call({
      rawPath: path,
      body: text,
      isBase64Encoded: false,
      headers: { authorization, ...opts.headers },
      queryStringParameters: opts.query,
      requestContext: { http: { method } },
    });
    return { ...res, json: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const res = await call({
      rawPath: url.pathname,
      body: await req.text(),
      isBase64Encoded: false,
      headers,
      queryStringParameters: Object.keys(query).length ? query : undefined,
      requestContext: { http: { method: req.method } },
    });
    return new Response(res.statusCode === 304 ? null : res.body, {
      status: res.statusCode,
      headers: res.headers,
    });
  }) as typeof fetch;

  return { store, clock, logs, call, send, fetch: fetchImpl };
}
