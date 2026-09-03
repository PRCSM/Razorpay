/**
 * Run the diagnose stage.
 *
 *   pnpm diagnose              rules + downtime + LLM tail
 *   pnpm diagnose --rules-only no LLM at all, for scoring the table in isolation
 *   pnpm diagnose --reset      clear existing diagnoses first, then re-diagnose
 *
 * Prints the rule / LLM / downtime split, the unknown rate, and the LLM
 * parse-failure rate — the numbers docs/POLICY_SPEC.md §6 requires be reported
 * rather than papered over.
 */

import { getWorkerEnv, loadPolicy } from '@reflow/core';
import { closeAllPools, createPooledDb, exceptions, recoveryCases } from '@reflow/db';
import { GroqClient, GroqDiagnosisTail } from '@reflow/llm';
import { eq, sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { countUndiagnosedCases, runDiagnosePass } from '../diagnose/index';
import { findStaleOpenWindows } from '../ingest/downtime';
import { PostgresLlmCache } from '../llm/pg-cache';

const repoRoot = resolve(import.meta.dirname, '../../../..');

/** A window open longer than this is almost certainly a missed `.resolved`. */
const STALE_WINDOW_HOURS = 24;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const rulesOnly = process.argv.includes('--rules-only');
  const reset = process.argv.includes('--reset');

  const env = getWorkerEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);

  const { db } = createPooledDb(env.DATABASE_URL, { max: 2 });

  try {
    if (reset) {
      // Exceptions reference cases, so they go first.
      const clearedExceptions = await db.delete(exceptions).returning({ id: exceptions.id });
      const cleared = await db
        .update(recoveryCases)
        .set({ rootCause: null, causeConfidence: null, causeBy: null, status: 'open' })
        .returning({ id: recoveryCases.id });
      console.log(
        `[diagnose] --reset: cleared ${cleared.length} diagnosis/es and ${clearedExceptions.length} exception(s)`,
      );
    }

    const pending = await countUndiagnosedCases(db);
    console.log(`[diagnose] undiagnosed cases: ${pending}`);
    if (pending === 0) {
      console.log('[diagnose] nothing to do.');
      return;
    }

    // A stale open window would match every later failure on that bank forever.
    const stale = await findStaleOpenWindows(db, STALE_WINDOW_HOURS, new Date());
    if (stale.length > 0) {
      console.warn(
        `[diagnose] WARNING: ${stale.length} downtime window(s) open > ${STALE_WINDOW_HOURS}h — ` +
          'a missed payment.downtime.resolved would over-attribute issuer_down:',
      );
      for (const w of stale) {
        console.warn(`  ${w.id} issuer=${w.issuer ?? 'any'} since ${w.startedAt.toISOString()}`);
      }
    }

    let tail: GroqDiagnosisTail | undefined;
    let cache: PostgresLlmCache | undefined;

    if (!rulesOnly) {
      cache = new PostgresLlmCache(db);
      const client = new GroqClient({
        apiKey: env.GROQ_API_KEY,
        models: {
          diagnosis: env.LLM_MODEL_DIAGNOSIS,
          copy: env.LLM_MODEL_COPY,
          guard: env.LLM_MODEL_GUARD,
        },
        cache,
      });
      tail = new GroqDiagnosisTail({
        client,
        injection: {
          enabled: policy.gates.injection_screen.enabled,
          threshold: policy.gates.injection_screen.threshold,
        },
      });
      console.log(`[diagnose] LLM tail enabled — diagnosis model ${env.LLM_MODEL_DIAGNOSIS}`);
      console.log(`[diagnose] gate 0 model         — ${env.LLM_MODEL_GUARD}`);
    } else {
      console.log('[diagnose] --rules-only: no LLM tail, unmatched tuples become unknown');
    }

    const started = Date.now();
    const summary = await runDiagnosePass(db, {
      ...(tail ? { tail } : {}),
      includeSynthetic: true,
      onProgress: (done, total) => console.log(`[diagnose] ${done}/${total}`),
    });
    const elapsedMs = Date.now() - started;

    console.log('\n=== DIAGNOSIS SPLIT ===');
    console.log(`scanned            : ${summary.scanned}`);
    console.log(`diagnosed          : ${summary.diagnosed}`);
    console.log(`failed             : ${summary.failed}`);
    console.log(
      `by rule            : ${summary.byRule}  ${pct(summary.ruleShare)}   <- should dominate`,
    );
    console.log(`by downtime signal : ${summary.byDowntimeSignal}  ${pct(summary.downtimeShare)}`);
    console.log(`by LLM             : ${summary.byLlm}  ${pct(summary.llmShare)}`);
    console.log(`unknown            : ${summary.unknown}  ${pct(summary.unknownRate)}`);
    console.log(`exceptions created : ${summary.exceptionsCreated}`);
    console.log(`LLM calls          : ${summary.llmCalls}`);
    console.log(`LLM cache hits     : ${summary.cacheHits}`);
    console.log(`parse-failure rate : ${pct(summary.parseFailureRate)}`);
    if (tail) {
      console.log(`gate 0 blocked     : ${tail.blockedByGuard}`);
      console.log(`retries used       : ${tail.retriesUsed}`);
    }
    if (cache) {
      console.log(`cache hits/misses  : ${cache.hits}/${cache.misses} (writes ${cache.writes})`);
    }
    console.log(`elapsed            : ${(elapsedMs / 1000).toFixed(1)}s`);

    console.log('\n-- causes assigned --');
    const entries = Object.entries(summary.causeCounts).sort((a, b) => b[1] - a[1]);
    for (const [cause, count] of entries) {
      console.log(`  ${cause.padEnd(30)} ${String(count).padStart(4)}`);
    }

    for (const warning of summary.warnings) {
      console.warn(`[diagnose] ${warning}`);
    }

    const remaining = await countUndiagnosedCases(db);
    console.log(`\n[diagnose] undiagnosed remaining: ${remaining}`);

    // Row-level confirmation, not a trust-the-counter claim.
    const persisted = await db.execute<{ n: string | number; by: string }>(sql`
      SELECT cause_by AS by, COUNT(*) AS n
      FROM recovery_cases
      WHERE root_cause IS NOT NULL
      GROUP BY cause_by
      ORDER BY n DESC
    `);
    console.log('[diagnose] persisted cause_by in Neon:');
    for (const row of persisted.rows) {
      console.log(`  ${String(row.by).padEnd(18)} ${Number(row.n)}`);
    }
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error('[diagnose] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
