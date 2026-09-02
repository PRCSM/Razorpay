import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

/**
 * Drizzle Kit config.
 *
 * Workflow per docs/DATABASE_DESIGN.md:
 *   pnpm db:generate  → review the SQL → pnpm db:migrate
 *
 * Never edit an applied migration; add a new one.
 *
 * `.env.local` lives at the repository root, two levels up from packages/db.
 * Loaded here explicitly because drizzle-kit runs as its own process and does not
 * inherit Next.js's env loading.
 *
 * `process.cwd()` rather than `import.meta.dirname`: drizzle-kit bundles this
 * config and evaluates it as CommonJS, where `import.meta` is unavailable. The
 * cwd is packages/db, because that is where the `generate` script runs.
 */
const repoRoot = resolve(process.cwd(), '../..');
loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. drizzle-kit needs it to introspect and migrate. ' +
      'Add it to .env.local at the repository root — see docs/ENVIRONMENT_VARIABLES.md.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
