/**
 * Apply pending migrations.
 *
 * Uses the node-postgres driver rather than the HTTP one: migrations run inside
 * a transaction, which the serverless HTTP driver cannot hold.
 *
 * Run with `pnpm db:migrate`.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve } from 'node:path';
import { createPooledDb } from '../client';
import { bootstrapDbEnv, describeConnection } from './env';

async function main(): Promise<void> {
  const { databaseUrl } = bootstrapDbEnv();
  const migrationsFolder = resolve(import.meta.dirname, '../../drizzle');

  console.log('[migrate] target     :', describeConnection(databaseUrl));
  console.log('[migrate] migrations :', migrationsFolder);

  const { db, pool } = createPooledDb(databaseUrl, { max: 1 });
  try {
    const startedAt = Date.now();
    await migrate(db, { migrationsFolder });
    console.log(`[migrate] done in ${Date.now() - startedAt}ms`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[migrate] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
