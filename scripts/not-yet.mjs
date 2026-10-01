// Placeholder for scripts whose implementation lands in a later phase (docs/06-PLAN.md).
// Exits non-zero on purpose, so nobody mistakes a stub for a passing check.
const [name, task, ...what] = process.argv.slice(2);
console.error(
  `npm run ${name}: not implemented yet. Arrives with ${task} ${what.join(' ')} (docs/06-PLAN.md).`,
);
process.exit(1);
