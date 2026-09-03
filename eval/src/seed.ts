/**
 * Seed synthetic cases into Neon.
 *
 *   pnpm eval:seed 500 --seed 42
 *
 * Deletes existing synthetic cases before inserting, so re-running with the same
 * seed converges on an identical dataset rather than accumulating duplicates.
 *
 * The delete is scoped to `is_synthetic = true`. Live cases are never touched —
 * that separation is the whole basis of the two-lane honesty claim in
 * docs/EVAL_METHODOLOGY.md.
 */

import { closeAllPools, createPooledDb, merchants, recoveryCases } from '@reflow/db';
import { asc, eq, sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import {
  describeDistribution,
  fingerprintCases,
  generateCases,
  type SyntheticCase,
} from './generator/index';
import {
  PAYMENT_CAUSE_MIX,
  SOURCE_MIX,
  TERMINAL_SHARE,
} from './generator/distribution';

const repoRoot = resolve(import.meta.dirname, '../..');

const DEFAULT_COUNT = 500;
const DEFAULT_SEED = 42;

/**
 * Fixed reference date.
 *
 * The simulation window must not move with the wall clock, or "same seed, same
 * dataset" would silently stop being true tomorrow. This is the anchor; override
 * with `--reference-date`.
 */
const DEFAULT_REFERENCE_DATE = '2026-03-01T00:00:00.000Z';

interface CliArgs {
  readonly count: number;
  readonly seed: number;
  readonly referenceDate: Date;
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let count = DEFAULT_COUNT;
  let seed = DEFAULT_SEED;
  let referenceDate = new Date(DEFAULT_REFERENCE_DATE);
  let dryRun = false;

  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--seed') {
      const value = argv[i + 1];
      i += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error(`--seed requires an integer, got "${String(value)}"`);
      }
      seed = parsed;
      continue;
    }
    if (arg.startsWith('--seed=')) {
      const parsed = Number(arg.slice('--seed='.length));
      if (!Number.isInteger(parsed)) throw new Error(`--seed requires an integer`);
      seed = parsed;
      continue;
    }
    if (arg === '--reference-date') {
      const value = argv[i + 1];
      i += 1;
      const parsed = new Date(String(value));
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`--reference-date requires an ISO date, got "${String(value)}"`);
      }
      referenceDate = parsed;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown flag "${arg}"`);
    }
    rest.push(arg);
  }

  const positional = rest[0];
  if (positional !== undefined) {
    const parsed = Number(positional);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`case count must be a positive integer, got "${positional}"`);
    }
    count = parsed;
  }

  return { count, seed, referenceDate, dryRun };
}

function formatPercent(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Print the actual breakdown next to the target, so it can be eyeballed. */
function printReport(cases: readonly SyntheticCase[]): void {
  const report = describeDistribution(cases);

  console.log('\n=== SYNTHETIC DISTRIBUTION ===');
  console.log(`total cases: ${report.total}`);

  console.log('\n-- source mix (target 55/20/15/10) --');
  for (const entry of SOURCE_MIX) {
    const actual = report.bySource[entry.value] ?? 0;
    console.log(
      `  ${entry.value.padEnd(11)} ${String(actual).padStart(4)}  ` +
        `${formatPercent(actual, report.total).padStart(6)}  target ${entry.weight}%`,
    );
  }

  console.log(`\n-- terminal cases (target ${(TERMINAL_SHARE * 100).toFixed(0)}%) --`);
  console.log(
    `  terminal    ${String(report.terminalCount).padStart(4)}  ` +
      `${formatPercent(report.terminalCount, report.total).padStart(6)}`,
  );

  console.log(
    `\n-- payment root causes, non-terminal only (n=${report.paymentNonTerminal}) --`,
  );
  for (const entry of PAYMENT_CAUSE_MIX) {
    const actual = report.paymentCauses[entry.value] ?? 0;
    console.log(
      `  ${entry.value.padEnd(23)} ${String(actual).padStart(4)}  ` +
        `${formatPercent(actual, report.paymentNonTerminal).padStart(6)}  target ${entry.weight}%`,
    );
  }

  console.log('\n-- issuer_down bursts (target: clusters of 8-20 in 30min) --');
  const sizes = report.issuerDownBursts.map((b) => b.size);
  for (const burst of report.issuerDownBursts) {
    console.log(`  ${String(burst.size).padStart(3)} cases  ${burst.issuer.padEnd(9)} from ${burst.startIso}`);
  }
  console.log(
    `  ${report.issuerDownBursts.length} burst(s), sizes [${sizes.join(', ')}], ` +
      `${sizes.reduce((a, b) => a + b, 0)} issuer_down cases total`,
  );

  console.log('\n-- insufficient_funds salary clustering (target: 18th-28th IST) --');
  console.log(
    `  ${report.insufficientFundsInSalaryWindow}/${report.insufficientFundsTotal} in window  ` +
      `${formatPercent(report.insufficientFundsInSalaryWindow, report.insufficientFundsTotal)}`,
  );

  console.log('\n-- integrity --');
  console.log(`  cases with complete ground_truth: ${report.withGroundTruth}/${report.total}`);
  console.log(`  unique customers                : ${report.uniqueCustomers}`);
  console.log(
    `  total at risk                   : ₹${(report.amountPaiseTotal / 100).toLocaleString('en-IN')}`,
  );
  console.log('=== END DISTRIBUTION ===\n');
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const args = parseArgs(process.argv.slice(2));

  console.log(
    `[eval:seed] generating ${args.count} cases · seed ${args.seed} · ` +
      `reference ${args.referenceDate.toISOString()}`,
  );

  const cases = generateCases({
    count: args.count,
    seed: args.seed,
    referenceDate: args.referenceDate,
  });

  printReport(cases);

  const fingerprint = fingerprintCases(cases);
  // A short digest is enough to compare two runs at a glance.
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(fingerprint, 'utf8').digest('hex').slice(0, 16);
  console.log(`[eval:seed] dataset fingerprint: ${digest}`);
  console.log('[eval:seed] same seed + count + reference date must reproduce this exactly.\n');

  if (args.dryRun) {
    console.log('[eval:seed] --dry-run: nothing written.');
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — add it to .env.local at the repository root.');
  }

  const { db } = createPooledDb(databaseUrl, { max: 1 });
  try {
    const merchantRows = await db
      .select({ id: merchants.id })
      .from(merchants)
      .orderBy(asc(merchants.createdAt))
      .limit(1);
    const merchant = merchantRows[0];
    if (!merchant) {
      throw new Error('No merchant found. Run `pnpm db:seed` first.');
    }

    // Scoped to the synthetic lane. Live cases are untouched.
    const deleted = await db
      .delete(recoveryCases)
      .where(eq(recoveryCases.isSynthetic, true))
      .returning({ id: recoveryCases.id });
    console.log(`[eval:seed] cleared ${deleted.length} existing synthetic case(s)`);

    const rows = cases.map((c) => ({
      merchantId: merchant.id,
      source: c.source,
      externalRef: c.externalRef,
      amountPaise: c.amountPaise,
      currency: c.currency,
      customerRef: c.customerRef,
      method: c.method,
      issuer: c.issuer,
      errorCode: c.errorCode,
      errorSource: c.errorSource,
      errorStep: c.errorStep,
      errorReason: c.errorReason,
      status: 'open' as const,
      openedAt: c.openedAt,
      isSynthetic: true,
      groundTruth: c.groundTruth,
    }));

    // Chunked: a single 500-row INSERT exceeds sensible parameter counts.
    const CHUNK = 100;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await db.insert(recoveryCases).values(chunk);
      inserted += chunk.length;
    }
    console.log(`[eval:seed] inserted ${inserted} synthetic case(s)`);

    const verify = await db.execute<{ n: string | number; gt: string | number }>(sql`
      SELECT COUNT(*) AS n,
             COUNT(ground_truth) AS gt
      FROM recovery_cases
      WHERE is_synthetic = true
    `);
    const row = verify.rows[0];
    console.log(
      `[eval:seed] in Neon: ${Number(row?.n ?? 0)} synthetic case(s), ` +
        `${Number(row?.gt ?? 0)} with ground_truth`,
    );
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error('[eval:seed] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
