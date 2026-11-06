import { signRequest, type Envelope } from '@junction/core';

// The local agent's client for the squad server. Every request is signed with the member key
// (docs/03 "Squad server API"). It sends nothing but signed envelopes and IDs, and never an
// Events API token.

export interface RelayClientOptions {
  baseUrl: string;
  kid: string;
  secretKey: Uint8Array;
  /** Epoch milliseconds. */
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  fetch?: typeof fetch;
}

export interface RelayResponse<T> {
  status: number;
  ok: boolean;
  body: T;
}

export interface RelayErrorBody {
  error: string;
  message: string;
  [key: string]: unknown;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly body: RelayErrorBody,
  ) {
    super(body.message);
    this.name = 'RelayError';
  }
}

export interface SquadSnapshot {
  etag: string | undefined;
  charter: Envelope;
  manifests: Envelope[];
}

export interface ClaimResult {
  won: boolean;
  sessionId: string;
  winner: string;
  claim?: Envelope;
}

export interface Announcement {
  sessionId: string;
  memberId: string;
  announcedAt: string;
  first: boolean;
}

export interface SignalPage {
  signals: { envelope: Envelope; receivedAt: string }[];
  cursor?: string;
  more: boolean;
}

export interface JoinRequest {
  memberId: string;
  publicKey: string;
  name: string;
  requestedAt: string;
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    query = '',
  ): Promise<RelayResponse<T> & { headers: Headers }> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const authorization = signRequest(
      { method, path, body: text },
      this.options.kid,
      this.options.secretKey,
      Math.floor(this.options.now() / 1000),
      this.options.randomBytes(16),
    );
    const headers: Record<string, string> = { authorization, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.baseUrl}${path}${query}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: text }),
    });
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {
          error: 'bad-response',
          message: 'The squad server returned something that is not JSON. Check the server URL.',
        };
      }
    }
    return { status: res.status, ok: res.ok, body: parsed as T, headers: res.headers };
  }

  private async expect<T>(res: RelayResponse<unknown>, ...okStatuses: number[]): Promise<T> {
    if (okStatuses.includes(res.status)) return res.body as T;
    const body = (res.body ?? {}) as Partial<RelayErrorBody>;
    throw new RelayError(res.status, {
      ...body,
      error: body.error ?? `http-${res.status}`,
      message: body.message ?? `The squad server answered ${res.status}.`,
    });
  }

  private squadPath(squadId: string): string {
    return `/v1/squads/${encodeURIComponent(squadId)}`;
  }

  async health(): Promise<boolean> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/health`);
    return res.status === 200;
  }

  async createSquad(charter: Envelope): Promise<{ squadId: string; seq: number }> {
    return this.expect(await this.request('POST', '/v1/squads', charter), 201);
  }

  async putCharter(squadId: string, charter: Envelope): Promise<{ squadId: string; seq: number }> {
    return this.expect(
      await this.request('PUT', `${this.squadPath(squadId)}/charter`, charter),
      200,
    );
  }

  /** Returns undefined when `etag` still matches (304). */
  async getSquad(squadId: string, etag?: string): Promise<SquadSnapshot | undefined> {
    const res = await this.request<{ charter: Envelope; manifests: Envelope[] }>(
      'GET',
      this.squadPath(squadId),
      undefined,
      etag === undefined ? {} : { 'if-none-match': etag },
    );
    if (res.status === 304) return undefined;
    const body = await this.expect<{ charter: Envelope; manifests: Envelope[] }>(res, 200);
    return {
      etag: res.headers.get('etag') ?? undefined,
      charter: body.charter,
      manifests: body.manifests,
    };
  }

  async putManifest(
    squadId: string,
    memberId: string,
    manifest: Envelope,
  ): Promise<{ memberId: string; seq: number }> {
    return this.expect(
      await this.request(
        'PUT',
        `${this.squadPath(squadId)}/members/${encodeURIComponent(memberId)}/manifest`,
        manifest,
      ),
      200,
    );
  }

  async postSignal(squadId: string, signal: Envelope): Promise<{ cursor: string }> {
    return this.expect(
      await this.request('POST', `${this.squadPath(squadId)}/signals`, signal),
      201,
    );
  }

  async listSignals(squadId: string, since?: string): Promise<SignalPage> {
    const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
    return this.expect(
      await this.request('GET', `${this.squadPath(squadId)}/signals`, undefined, {}, query),
      200,
    );
  }

  /** The earliest announcement wins; every caller learns who announced first and when. */
  async postAnnouncement(squadId: string, sessionId: string): Promise<Announcement> {
    return this.expect(
      await this.request('POST', `${this.squadPath(squadId)}/announcements`, { sessionId }),
      200,
      201,
    );
  }

  /** A lost race is not an error: it returns `won: false` and the winner. */
  async postClaim(squadId: string, claim: Envelope): Promise<ClaimResult> {
    const res = await this.request<{ sessionId: string; winner: string; claim?: Envelope }>(
      'POST',
      `${this.squadPath(squadId)}/claims`,
      claim,
    );
    if (res.status === 409 && (res.body as { error?: string }).error === 'already-claimed') {
      return { won: false, ...res.body };
    }
    const body = await this.expect<{ sessionId: string; winner: string; claim?: Envelope }>(
      res,
      200,
      201,
    );
    return { won: body.winner === this.options.kid, ...body };
  }

  /** Signed with the requester's own key; the body carries that public key. */
  async postJoinRequest(
    squadId: string,
    request: { publicKey: string; name: string; inviteSecret: string },
  ): Promise<{ memberId: string; status: 'pending' | 'member' }> {
    return this.expect(
      await this.request('POST', `${this.squadPath(squadId)}/join-requests`, request),
      200,
      202,
    );
  }

  async listJoinRequests(squadId: string): Promise<JoinRequest[]> {
    const body = await this.expect<{ requests: JoinRequest[] }>(
      await this.request('GET', `${this.squadPath(squadId)}/join-requests`),
      200,
    );
    return body.requests;
  }

  /** Removes a member's data. Defaults to the signed-in member. */
  async leave(squadId: string, memberId: string = this.options.kid): Promise<{ removed: number }> {
    return this.expect(
      await this.request(
        'DELETE',
        `${this.squadPath(squadId)}/members/${encodeURIComponent(memberId)}`,
      ),
      200,
    );
  }

  async purge(squadId: string): Promise<{ purged: boolean }> {
    return this.expect(await this.request('DELETE', this.squadPath(squadId)), 200);
  }
}
