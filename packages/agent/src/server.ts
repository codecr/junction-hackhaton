import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Junction } from './app';
import { exportPicksBlock, importBlock } from './squad';

// The local UI server (docs/02, "Local HTTP server"). Loopback only, Host allowlist against DNS
// rebinding, a per-launch secret on every state-changing call, Origin must be this server, strict
// CSP, no CORS. The browser never receives a token: it only sees the SquadView.

export const UI_PORT = 4848;
const MAX_BODY = 256 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export function defaultWebDist(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', 'web', 'dist');
}

export interface UiServer {
  server: Server;
  url: string;
  secret: string;
}

export function startUiServer(
  app: Junction,
  opts: { port?: number; webDist?: string } = {},
): Promise<UiServer> {
  const port = opts.port ?? UI_PORT;
  const dist = opts.webDist ?? defaultWebDist();
  const secret = randomBytes(24).toString('base64url');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  let loginInFlight: Promise<void> | undefined;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    send(res, status, { error: { code, message } });

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((ok, ko) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          ko(new Error('Request too large.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          ok(text ? JSON.parse(text) : {});
        } catch {
          ko(new Error('The request body is not JSON.'));
        }
      });
      req.on('error', ko);
    });

  const secretOk = (req: IncomingMessage) => {
    const given = req.headers['x-junction-secret'];
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dist, urlPath));
    if (!file.startsWith(dist + sep) && file !== dist) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('The web UI is not built yet. Run `npm run build:web`, then restart `junction ui`.');
      return;
    }
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith('index.html')) {
      body = body
        .toString('utf8')
        .replace('<head>', `<head><meta name="junction-secret" content="${secret}">`);
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      ...SECURITY_HEADERS,
    });
    res.end(body);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin))
        return fail(res, 403, 'origin', 'Requests from other sites are refused.');
      if (!secretOk(req))
        return fail(
          res,
          403,
          'secret',
          'Reload the page: this tab was opened before the agent restarted.',
        );
    }
    if (method === 'GET' && path === '/api/state') return send(res, 200, app.state());
    if (method === 'GET' && path === '/api/squad/export')
      return send(res, 200, { text: exportPicksBlock() });
    if (method === 'POST' && path === '/api/sync') return send(res, 200, await app.sync());
    if (method === 'POST' && path === '/api/login') {
      loginInFlight ??= app.login().finally(() => {
        loginInFlight = undefined;
      });
      loginInFlight.catch(() => undefined);
      return send(res, 200, { started: true });
    }
    if (method === 'POST' && path === '/api/logout') {
      await app.logout();
      return send(res, 200, app.state());
    }
    if (method === 'POST' && path === '/api/squad/import') {
      const body = (await readBody(req)) as { text?: unknown };
      if (typeof body.text !== 'string')
        return fail(res, 400, 'bad-request', 'Paste a block that starts with "junction1:".');
      importBlock(body.text);
      return send(res, 200, app.state());
    }
    const m = /^\/api\/proposals\/([0-9a-f]{6,64})\/(accept|decline|undo)$/.exec(path);
    if (method === 'POST' && m) {
      const [, id, action] = m as unknown as [string, string, 'accept' | 'decline' | 'undo'];
      if (action === 'accept') return send(res, 200, await app.accept(id));
      if (action === 'undo') return send(res, 200, await app.undo(id));
      return send(res, 200, await app.decline(id));
    }
    return fail(res, 404, 'not-found', 'No such endpoint.');
  };

  const server = createServer((req, res) => {
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Unknown host.');
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) {
      handleApi(req, res, path).catch((e: unknown) => {
        fail(res, 500, 'failed', e instanceof Error ? e.message : 'Unexpected failure.');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res);
  });

  return new Promise((ok, ko) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      ko(
        e.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is in use. Is Junction already running? Open http://127.0.0.1:${port}.`,
            )
          : e,
      ),
    );
    server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${port}`, secret }));
  });
}
