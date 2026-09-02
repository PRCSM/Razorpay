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
 * Loaded here explicitly because drizzle-kit runs as its own process and does
 * not inherit Next.js's env loading.
 */
const repoRoot = resolve(import.meta.dirname, '../..');
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
