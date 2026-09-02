import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      'packages/db/drizzle/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ------------------------------------------------------------------
  // THE PURITY FENCE for packages/core.
  //
  // docs/ARCHITECTURE.md calls this "the single most important
  // constraint in the codebase". The eval harness claims its numbers
  // describe the system that actually runs; that is only true if the
  // harness and the live worker execute the same code. So core may not
  // touch the network, the database, the filesystem, or the clock.
  //
  // Enforced by the linter rather than by discipline, because a comment
  // has never once stopped a `Date.now()` from being added at 2am.
  // ------------------------------------------------------------------
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: [
      // The two documented boundary adapters. See DECISIONS.md D-17.
      'packages/core/src/env/load.ts',
      'packages/core/src/policy/load.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'core is pure: no network. Do I/O in apps/ and pass data in.' },
        { name: 'process', message: 'core is pure: no process/env access. Pass config in.' },
        { name: 'XMLHttpRequest', message: 'core is pure: no network.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'core is pure: no filesystem.' },
            { name: 'node:fs', message: 'core is pure: no filesystem.' },
            { name: 'fs/promises', message: 'core is pure: no filesystem.' },
            { name: 'node:fs/promises', message: 'core is pure: no filesystem.' },
            { name: 'path', message: 'core is pure: no filesystem paths.' },
            { name: 'node:path', message: 'core is pure: no filesystem paths.' },
            { name: '@reflow/db', message: 'core is pure: no database. Pass rows in as plain data.' },
            { name: '@reflow/llm', message: 'core is pure: no network-backed providers.' },
            { name: 'drizzle-orm', message: 'core is pure: no database.' },
          ],
          patterns: [
            { group: ['@reflow/db/*'], message: 'core is pure: no database.' },
            { group: ['**/apps/**'], message: 'core must not depend on an application.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'core is pure: time is a parameter. Accept `now: Date` and pass it in.',
        },
        {
          object: 'Math',
          property: 'random',
          message:
            'core is pure and must be deterministic: inject a seeded RNG instead of Math.random().',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'core is pure: `new Date()` reads the clock. Accept `now: Date` as a parameter.',
        },
      ],
    },
  },

  // Config files and scripts are allowed to be impure.
  {
    files: ['**/*.config.ts', '**/scripts/**/*.ts', 'eval/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
