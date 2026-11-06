// Builds the demo, serves it locally, and saves full-page screenshots at 1440 and 390 px into
// design/current/. Also fails if the demo requests anything other than its own static files.
// Usage: npm run shots            (from the repo root or packages/web)
//        node scripts/shots.mjs --no-build

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const dist = join(web, 'dist-demo');
const out = resolve(web, '../../design/current');

if (!process.argv.includes('--no-build')) {
  const r = spawnSync('npx vite build --mode demo', { cwd: web, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = url.pathname;
  if (!path.startsWith('/demo/')) {
    res.writeHead(302, { Location: '/demo/' });
    res.end();
    return;
  }
  path = path.slice('/demo/'.length) || 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const s = await stat(file);
    const target = s.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const foreign = [];
const errors = [];
try {
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    page.on('request', (r) => {
      if (!r.url().startsWith(`${origin}/demo/`) && !r.url().startsWith('data:')) foreign.push(r.url());
    });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
    });
    await page.goto(`${origin}/demo/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('svg.chart');
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    console.log(`saved design/current/${name}.png`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error(`The demo logged errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
}
if (foreign.length) {
  console.error(`The demo made requests outside its own files:\n${foreign.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('No requests outside the demo’s own static files.');
}
