// Assembles the static site served by Amplify Hosting into site-dist/:
//   /           landing page from site/landing, with design/tokens.css and the Archivo font
//   /demo/      the demo build of packages/web (built with base /demo/ into packages/web/dist-demo)
// Usage: node scripts/assemble-site.mjs [--allow-missing-demo]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site-dist');
const demo = join(root, 'packages', 'web', 'dist-demo');
const font = join(
  root,
  'node_modules',
  '@fontsource-variable',
  'archivo',
  'files',
  'archivo-latin-wdth-normal.woff2',
);
const allowMissingDemo = process.argv.includes('--allow-missing-demo');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, 'site', 'landing'), out, { recursive: true });
cpSync(join(root, 'design', 'tokens.css'), join(out, 'tokens.css'));

if (existsSync(font)) {
  mkdirSync(join(out, 'fonts'), { recursive: true });
  cpSync(font, join(out, 'fonts', 'archivo-latin-wdth-normal.woff2'));
} else {
  console.warn(
    'Archivo font not found in node_modules; the landing page falls back to system fonts.',
  );
}

if (existsSync(join(demo, 'index.html'))) {
  cpSync(demo, join(out, 'demo'), { recursive: true });
} else if (allowMissingDemo) {
  console.warn('packages/web/dist-demo is missing; site-dist has no /demo/.');
} else {
  console.error(
    'packages/web/dist-demo/index.html is missing. Run `npm run build:demo -w @junction/web` first, or pass --allow-missing-demo.',
  );
  process.exit(1);
}

console.log(`Site assembled in ${out}`);
