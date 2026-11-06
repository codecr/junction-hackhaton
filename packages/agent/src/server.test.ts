import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Junction } from './app';
import { startUiServer, type UiServer } from './server';

const PORT = 48_481;
let ui: UiServer;

function get(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: { host: `127.0.0.1:${PORT}`, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.JUNCTION_HOME = mkdtempSync(join(tmpdir(), 'junction-ui-'));
  const dist = mkdtempSync(join(tmpdir(), 'junction-dist-'));
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  ui = await startUiServer(new Junction(), { port: PORT, webDist: dist });
});

afterAll(() => ui.server.close());

describe('local UI server defences', () => {
  it('survives a malformed URL from another site', async () => {
    expect((await get('/%E0%A4%A')).status).toBe(400);
    expect((await get('/api/state')).status).toBe(200);
  });
  it('refuses unknown hosts (DNS rebinding)', async () => {
    expect((await get('/api/state', { host: 'evil.example:4848' })).status).toBe(421);
  });
  it('refuses state changes without the per-launch secret or from another origin', async () => {
    expect((await get('/api/sync', {}, 'POST')).status).toBe(403);
    expect(
      (
        await get(
          '/api/sync',
          { origin: 'https://evil.example', 'x-junction-secret': ui.secret },
          'POST',
        )
      ).status,
    ).toBe(403);
  });
  it('injects the secret into the page and never a token', async () => {
    const page = await get('/');
    expect(page.body).toContain(`<meta name="junction-secret" content="${ui.secret}">`);
    const state = await get('/api/state');
    expect(state.body).not.toMatch(/accessToken|refreshToken|Bearer/);
  });
});
