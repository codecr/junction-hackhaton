import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { paths, readJson, removeFile, writeJson } from './paths';

// OAuth 2.0 authorization code with PKCE against AWS Builder ID (docs/04, "Authentication"). The
// loopback listener is open only while signing in, on 8484 with fallback through 8489. Tokens stay
// in ~/.junction/credentials.json (0600) and are only ever sent to oauth.awsevents.com and
// api.awsevents.com. Nothing here logs a token.

export const OAUTH = {
  authorize: 'https://oauth.awsevents.com/oauth2/authorize',
  token: 'https://oauth.awsevents.com/oauth2/token',
  revoke: 'https://oauth.awsevents.com/oauth2/revoke',
  builderIdSignOut: 'https://profile.aws.amazon.com',
  clientId: '7vmom55m1qstvq8i71ph127bfq',
  scope: 'openid email events/access',
} as const;
export const CALLBACK_PORTS = [8484, 8485, 8486, 8487, 8488, 8489] as const;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;

const credentialsSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
});
export type Credentials = z.infer<typeof credentialsSchema>;

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function loadCredentials(): Credentials | undefined {
  const raw = readJson<unknown>(paths.credentials());
  const parsed = credentialsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function saveCredentials(c: Credentials): void {
  writeJson(paths.credentials(), c);
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<Response> {
  return fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
}

async function tokenRequest(
  form: Record<string, string>,
  fetchFn: typeof fetch,
  previousRefresh?: string,
): Promise<Credentials> {
  const res = await postForm(OAUTH.token, form, fetchFn);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: string } | undefined)?.error ?? `status ${res.status}`;
    throw new Error(`Sign-in failed at the token endpoint (${err}). Run \`junction login\` again.`);
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      'The token endpoint answered in an unexpected shape. Run `junction login` again.',
    );
  const refreshToken = parsed.data.refresh_token ?? previousRefresh;
  if (!refreshToken)
    throw new Error('The token endpoint returned no refresh token. Run `junction login` again.');
  return {
    accessToken: parsed.data.access_token,
    refreshToken,
    expiresAt: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
  };
}

function listenOnFirstFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      const port = CALLBACK_PORTS[i];
      if (port === undefined) {
        reject(
          new Error(
            'Ports 8484 to 8489 are all in use, so sign-in cannot listen for the callback. Close the app using them (often another MCP sign-in) and try again.',
          ),
        );
        return;
      }
      const onError = (e: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') tryPort(i + 1);
        else reject(e);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryPort(0);
  });
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;background:#F3F6F7;color:#0E2233;padding:48px"><h1 style="font-size:22px">${title}</h1><p>${line}</p></body>`;

export interface LoginOptions {
  openBrowser: (url: string) => void;
  fetch?: typeof fetch;
  onUrl?: (url: string, port: number) => void;
}

/** Runs the whole sign-in. Resolves once tokens are stored. */
export async function login(opts: LoginOptions): Promise<void> {
  const fetchFn = opts.fetch ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state) {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(
          PAGE(
            'Sign-in not accepted',
            'This response did not come from the sign-in Junction started. Close this tab and run junction login again.',
          ),
        );
      return;
    }
    if (error || !code) {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(PAGE('Sign-in cancelled', 'Close this tab. Run junction login to try again.'));
      settle.reject(
        new Error(
          `Sign-in did not complete (${error ?? 'no code'}). Run \`junction login\` to try again.`,
        ),
      );
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        PAGE('Signed in to Junction', 'You can close this tab. Your tokens stay on this computer.'),
      );
    settle.resolve(code);
  });

  const port = await listenOnFirstFreePort(server);
  // The authorization request and the token exchange send this identical string.
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl = `${OAUTH.authorize}?${new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH.clientId,
    redirect_uri: redirectUri,
    scope: OAUTH.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    identity_provider: 'AWSBuilderID',
  })}`;
  opts.onUrl?.(authUrl, port);
  opts.openBrowser(authUrl);

  const timer = setTimeout(
    () =>
      settle.reject(new Error('Sign-in timed out after 5 minutes. Run `junction login` again.')),
    SIGN_IN_TIMEOUT_MS,
  );
  try {
    const code = await codePromise;
    const creds = await tokenRequest(
      {
        grant_type: 'authorization_code',
        client_id: OAUTH.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      fetchFn,
    );
    saveCredentials(creds);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** Serialised refresh: two callers never refresh at the same time. */
export class TokenProvider {
  private inflight: Promise<Credentials> | undefined;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  signedIn(): boolean {
    return loadCredentials() !== undefined;
  }

  async get(force = false): Promise<string> {
    const creds = loadCredentials();
    if (!creds) throw new Error('You are not signed in. Run `junction login` first.');
    if (!force && creds.expiresAt - Date.now() > REFRESH_MARGIN_MS) return creds.accessToken;
    this.inflight ??= this.refresh(creds).finally(() => {
      this.inflight = undefined;
    });
    return (await this.inflight).accessToken;
  }

  private async refresh(creds: Credentials): Promise<Credentials> {
    const next = await tokenRequest(
      { grant_type: 'refresh_token', client_id: OAUTH.clientId, refresh_token: creds.refreshToken },
      this.fetchFn,
      creds.refreshToken,
    );
    saveCredentials(next);
    return next;
  }
}

/** Revokes the refresh token and deletes stored tokens. The access token stays valid until it expires. */
export async function logout(fetchFn: typeof fetch = fetch): Promise<{ revoked: boolean }> {
  const creds = loadCredentials();
  let revoked = false;
  if (creds) {
    try {
      const res = await postForm(
        OAUTH.revoke,
        { token: creds.refreshToken, client_id: OAUTH.clientId },
        fetchFn,
      );
      revoked = res.ok;
    } catch {
      revoked = false;
    }
  }
  removeFile(paths.credentials());
  return { revoked };
}
