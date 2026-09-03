/**
 * Fingerprint the synthetic lane AS STORED IN NEON.
 *
 *   pnpm eval:fingerprint
 *
 * The in-memory determinism test proves the generator is reproducible. This
 * proves the round trip is too — that what landed in Postgres is identical
 * between two seeded runs, including timestamps and the ground_truth payload.
 *
 * Read-only.
 */

import { closeAllPools, createPooledDb } from '@reflow/db';
import { sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

interface CaseRow extends Record<string, unknown> {
  source: string;
  external_ref: string | null;
  amount_paise: string | number;
  currency: string;
  customer_ref: string | null;
  method: string | null;
  issuer: string | null;
  error_code: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  opened_at: string | Date;
  ground_truth: unknown;
}

/** Sorted keys, so the same object always serialises identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const { db } = createPooledDb(databaseUrl, { max: 1 });
  try {
    // Ordered by external_ref so the digest does not depend on row order.
    const result = await db.execute<CaseRow>(sql`
      SELECT source, external_ref, amount_paise, currency, customer_ref,
             method, issuer, error_code, error_source, error_step, error_reason,
             opened_at, ground_truth
      FROM recovery_cases
      WHERE is_synthetic = true
      ORDER BY external_ref ASC
    `);

    const lines = result.rows.map((row) =>
      [
        row.source,
        row.external_ref ?? '-',
        String(row.amount_paise),
        row.currency,
        row.customer_ref ?? '-',
        row.method ?? '-',
        row.issuer ?? '-',
        row.error_code ?? '-',
        row.error_source ?? '-',
        row.error_step ?? '-',
        row.error_reason ?? '-',
        new Date(row.opened_at as string).toISOString(),
        canonicalJson(row.ground_truth),
      ].join('|'),
    );

    const digest = createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');

    const counts = await db.execute<{ n: string | number; gt: string | number }>(sql`
      SELECT COUNT(*) AS n, COUNT(ground_truth) AS gt
      FROM recovery_cases WHERE is_synthetic = true
    `);
    const row = counts.rows[0];

    console.log(`synthetic cases in Neon : ${Number(row?.n ?? 0)}`);
    console.log(`with ground_truth       : ${Number(row?.gt ?? 0)}`);
    console.log(`DB fingerprint (sha256) : ${digest}`);
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error('[eval:fingerprint] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
