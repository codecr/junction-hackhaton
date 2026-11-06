import {
  SourceError,
  type ActionResult,
  type AppState,
  type DataSource,
  type SessionResult,
} from './types';

// Talks to the local agent that served this page. The agent puts a per-run secret in a meta tag;
// every POST carries it so another site in the browser cannot drive the agent. This module never
// sees an Events API token: the agent holds those and only returns squad state.

function readSecret(doc: Document): string {
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="junction-secret"]')) {
    if (meta.content) return meta.content;
  }
  return '';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function bad(what: string): never {
  throw new SourceError(
    'bad-response',
    `The local agent sent ${what} this page does not understand. Update Junction so the agent and the page match, then reload.`,
  );
}

export function parseState(v: unknown): AppState {
  if (!isRecord(v) || typeof v.signedIn !== 'boolean') bad('a state');
  const member = v.member;
  if (
    member !== null &&
    member !== undefined &&
    !(isRecord(member) && typeof member.memberId === 'string' && typeof member.name === 'string')
  )
    bad('a member');
  const squad = v.squad;
  if (
    squad !== null &&
    squad !== undefined &&
    !(
      isRecord(squad) &&
      Array.isArray(squad.members) &&
      Array.isArray(squad.days) &&
      Array.isArray(squad.venues) &&
      Array.isArray(squad.proposals) &&
      Array.isArray(squad.holdings) &&
      isRecord(squad.sessions) &&
      isRecord(squad.coverage)
    )
  )
    bad('a squad');
  const catalog = v.catalog;
  if (
    catalog !== null &&
    catalog !== undefined &&
    !(
      isRecord(catalog) &&
      typeof catalog.count === 'number' &&
      typeof catalog.fetchedAt === 'string'
    )
  )
    bad('a catalog summary');
  return {
    signedIn: v.signedIn,
    member: (member as AppState['member']) ?? null,
    squad: (squad as AppState['squad']) ?? null,
    lastSync: typeof v.lastSync === 'string' ? v.lastSync : null,
    catalog: (catalog as AppState['catalog']) ?? null,
  };
}

export function parseResults(v: unknown): SessionResult[] {
  if (!Array.isArray(v)) bad('write results');
  return v.map((r) => {
    if (
      !isRecord(r) ||
      typeof r.sessionId !== 'string' ||
      typeof r.code !== 'string' ||
      (r.action !== 'add' && r.action !== 'remove') ||
      typeof r.ok !== 'boolean' ||
      typeof r.detail !== 'string'
    )
      bad('a write result');
    return { sessionId: r.sessionId, code: r.code, action: r.action, ok: r.ok, detail: r.detail };
  });
}

function parseAction(v: unknown): ActionResult {
  if (!isRecord(v)) bad('a write outcome');
  return { results: parseResults(v.results), state: parseState(v.state) };
}

export function createAgentSource(doc: Document = document, f: typeof fetch = fetch): DataSource {
  const secret =
    readSecret(doc) || (import.meta.env.DEV ? (import.meta.env.VITE_JUNCTION_SECRET ?? '') : '');

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await f(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'X-Junction-Secret': secret } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new SourceError(
        'agent-unreachable',
        'The Junction agent on this machine is not answering. Start the agent again, then reload this page.',
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const err = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      const code = err && typeof err.code === 'string' ? err.code : `http-${res.status}`;
      const message =
        err && typeof err.message === 'string'
          ? err.message
          : `The local agent answered ${res.status}. Reload the page; if it keeps happening, restart the agent.`;
      throw new SourceError(code, message);
    }
    return payload;
  }

  const enc = encodeURIComponent;
  return {
    mode: 'agent',
    getState: async () => parseState(await call('GET', '/api/state')),
    sync: async () => parseState(await call('POST', '/api/sync')),
    accept: async (id) => parseAction(await call('POST', `/api/proposals/${enc(id)}/accept`)),
    decline: async (id) => parseState(await call('POST', `/api/proposals/${enc(id)}/decline`)),
    undo: async (id) => parseAction(await call('POST', `/api/proposals/${enc(id)}/undo`)),
    login: async () => {
      await call('POST', '/api/login');
    },
    logout: async () => parseState(await call('POST', '/api/logout')),
    exportPicks: async () => {
      const v = await call('GET', '/api/squad/export');
      if (!isRecord(v) || typeof v.text !== 'string') bad('a picks block');
      return v.text;
    },
    importPicks: async (text) => parseState(await call('POST', '/api/squad/import', { text })),
  };
}
