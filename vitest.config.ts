import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'infra/test/**/*.test.ts', 'fixtures/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'fixtures/private/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/core/src/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
