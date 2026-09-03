/**
 * Verify the migration actually reached the database.
 *
 * docs/INSTRUCTIONS.md: "Never claim a completion criterion passed without
 * running it." This script is the evidence for the schema criterion — it queries
 * `information_schema` and reports what really exists in Neon, rather than
 * inspecting migration files and assuming they were applied.
 *
 * Exits non-zero if any of the nine domain tables is missing.
 *
 * Run with `pnpm --filter @reflow/db verify`.
 */

import { sql } from 'drizzle-orm';
import { createPooledDb } from '../client';
import { DOMAIN_TABLE_NAMES, TABLE_NAMES } from '../table-names';
import { bootstrapDbEnv, describeConnection } from './env';

/**
 * `db.execute<T>` constrains T to `Record<string, unknown>`, so these row shapes
 * extend it rather than declaring bare properties.
 */
interface TableRow extends Record<string, unknown> {
  table_name: string;
}

interface CountRow extends Record<string, unknown> {
  n: string | number;
}

interface IndexRow extends Record<string, unknown> {
  tablename: string;
  indexname: string;
}

interface ColumnRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  data_type: string;
}

async function main(): Promise<void> {
  const { databaseUrl } = bootstrapDbEnv();
  console.log('[verify] target:', describeConnection(databaseUrl), '\n');

  const { db, pool } = createPooledDb(databaseUrl, { max: 1 });
  try {
    const tableResult = await db.execute<TableRow>(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const present = new Set(tableResult.rows.map((r) => r.table_name));

    console.log(`Tables in public schema (${present.size}):`);
    for (const name of [...present].sort()) {
      const label = (DOMAIN_TABLE_NAMES as readonly string[]).includes(name)
        ? 'domain'
        : (TABLE_NAMES as readonly string[]).includes(name)
          ? 'supporting'
          : 'other';
      console.log(`  - ${name}  [${label}]`);
    }

    const missingDomain = DOMAIN_TABLE_NAMES.filter((n) => !present.has(n));
    const missingAll = TABLE_NAMES.filter((n) => !present.has(n));

    console.log(
      `\nNine domain tables: ${DOMAIN_TABLE_NAMES.length - missingDomain.length}/${DOMAIN_TABLE_NAMES.length} present`,
    );

    // The constraint that prevents duplicate recovery cases from retried webhooks.
    const uniqueResult = await db.execute<CountRow>(sql`
      SELECT COUNT(*) AS n
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'raw_events'
        AND tc.constraint_type = 'UNIQUE'
        AND kcu.column_name = 'provider_event_id'
    `);
    const uniqueCount = Number(uniqueResult.rows[0]?.n ?? 0);
    console.log(
      `raw_events.provider_event_id UNIQUE: ${uniqueCount > 0 ? 'present' : 'MISSING'} (idempotency key)`,
    );

    // Every money column must be bigint. A numeric or double here is a bug.
    const moneyResult = await db.execute<ColumnRow>(sql`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%_paise'
      ORDER BY table_name, column_name
    `);
    console.log('\nMoney columns (must all be bigint):');
    let badMoney = 0;
    for (const row of moneyResult.rows) {
      const ok = row.data_type === 'bigint';
      if (!ok) badMoney += 1;
      console.log(`  ${ok ? 'OK  ' : 'BAD '} ${row.table_name}.${row.column_name} → ${row.data_type}`);
    }

    const indexResult = await db.execute<IndexRow>(sql`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    console.log(`\nIndexes: ${indexResult.rows.length}`);
    for (const row of indexResult.rows) {
      console.log(`  - ${row.tablename}.${row.indexname}`);
    }

    const merchantResult = await db.execute<CountRow>(
      sql`SELECT COUNT(*) AS n FROM merchants`,
    );
    console.log(`\nSeeded merchants: ${Number(merchantResult.rows[0]?.n ?? 0)}`);

    if (missingAll.length > 0 || uniqueCount === 0 || badMoney > 0) {
      console.error('\n[verify] FAILED');
      if (missingAll.length > 0) console.error(`  missing tables: ${missingAll.join(', ')}`);
      if (uniqueCount === 0) console.error('  missing UNIQUE on raw_events.provider_event_id');
      if (badMoney > 0) console.error(`  ${badMoney} money column(s) are not bigint`);
      process.exitCode = 1;
      return;
    }

    console.log('\n[verify] OK — schema matches docs/DATABASE_DESIGN.md');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[verify] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
