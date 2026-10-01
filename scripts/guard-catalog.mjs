// Fails when catalog data or private captures are tracked by git (CLAUDE.md rule 3).
// Runs as the pre-commit hook and in CI. Checks the index, so it sees staged files too.
import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

const offenders = tracked.filter(
  (file) =>
    file.startsWith('fixtures/private/') ||
    file.endsWith('.catalog.json') ||
    file.startsWith('.junction/') ||
    file.includes('/.junction/'),
);

if (offenders.length > 0) {
  console.error(
    'Catalog or private data is tracked by git. Remove it from the index (git rm --cached) and keep it under fixtures/private/, which is ignored:',
  );
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`guard-catalog: ${tracked.length} tracked files, none are catalog or private data.`);
