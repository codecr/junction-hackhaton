import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// packages/core must be a pure function of its inputs (CLAUDE.md rule 10): no clock, no randomness,
// no locale-dependent behaviour. Callers pass time, seeds and key material in.
const nondeterminism = [
  {
    selector: "CallExpression[callee.property.name='localeCompare']",
    message: 'localeCompare is locale dependent. Compare strings with < and > on code points.',
  },
  {
    selector: 'CallExpression[callee.property.name=/^toLocale/]',
    message: 'toLocale* methods are locale dependent. Format explicitly.',
  },
  {
    selector: "CallExpression[callee.property.name='getRandomValues']",
    message: 'core has no randomness. The caller supplies seeds and nonces.',
  },
  {
    selector: "CallExpression[callee.property.name='randomUUID']",
    message: 'core has no randomness. The caller supplies ids.',
  },
  {
    selector: "MemberExpression[object.name='crypto'][property.name='subtle']",
    message: 'Use @noble/hashes and @noble/curves, which behave the same on every runtime.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/cdk.out/**',
      'fixtures/private/**',
      'fixtures/demo/**',
      'design/**',
      '**/dist-demo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'core reads no clock. Take timestamps as input.' },
        { name: 'Intl', message: 'Intl is locale dependent. Not allowed in core.' },
        { name: 'performance', message: 'core reads no clock.' },
        { name: 'crypto', message: 'core has no randomness and uses @noble/* for hashing.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'core has no randomness.' },
      ],
      'no-restricted-syntax': ['error', ...nondeterminism],
    },
  },
);
