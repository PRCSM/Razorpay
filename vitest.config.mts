import { defineConfig } from 'vitest/config';

/**
 * Vitest, rooted at the workspace.
 *
 * Tests live beside their source as `*.test.ts` (docs/INSTRUCTIONS.md). No UI
 * component tests — not in this budget.
 *
 * `pnpm test` must be green before every phase-ending commit.
 */
export default defineConfig({
  test: {
    include: ['{packages,apps,eval}/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@reflow/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@reflow/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@reflow/llm': new URL('./packages/llm/src/index.ts', import.meta.url).pathname,
    },
  },
});
