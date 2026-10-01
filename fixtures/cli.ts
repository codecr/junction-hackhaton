// npm run fixtures [seed]: writes the demo squad to fixtures/demo/. Committed output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED, generateDemo, renderFiles } from './generate';

const seedArg = process.argv[2];
const seed = seedArg === undefined ? DEFAULT_SEED : Number(seedArg);
if (!Number.isInteger(seed)) {
  console.error(`The seed must be an integer, got "${seedArg}".`);
  process.exit(1);
}

const data = generateDemo(seed);
if (data.skipped.length > 0) {
  console.error(`Generated sessions were skipped by the mapper: ${JSON.stringify(data.skipped)}`);
  process.exit(1);
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'demo');
mkdirSync(out, { recursive: true });
for (const [name, content] of Object.entries(renderFiles(data))) {
  writeFileSync(join(out, name), content, 'utf8');
  console.log(`wrote fixtures/demo/${name}`);
}
console.log(
  `seed ${seed}, ${data.snapshot.sessions.length} sessions, ${data.members.length} members`,
);
