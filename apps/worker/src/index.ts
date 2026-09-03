/**
 * apps/worker — entrypoint.
 *
 * Run 1 scaffolds this: it validates its environment, loads and validates
 * policy.yaml, proves it can reach the database, and exits cleanly. No business
 * logic yet.
 *
 * The pipeline lands in later runs (docs/ARCHITECTURE.md):
 *   ingest → diagnose → plan → schedule → execute → observe → learn
 *
 * Why the worker exists at all: the recovery scheduler needs a long-running
 * process and Vercel functions are request-scoped. That is the entire
 * justification for the second deployable. It has NO public inbound surface —
 * Razorpay talks to Vercel, and the handoff to this process is the database.
 */

import { getWorkerEnv, loadPolicy } from '@reflow/core';
import { closeAllPools, createPooledDb } from '@reflow/db';
import { sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { countPendingEvents, runIngestPass } from './ingest/index';

const repoRoot = resolve(import.meta.dirname, '../../..');

/** How often to poll `raw_events` when running as a loop. */
const POLL_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  // Crash here, naming the variable, rather than failing obscurely later.
  const env = getWorkerEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);

  console.log('[worker] boot');
  console.log(`[worker] node             : ${process.version}`);
  console.log(`[worker] NODE_ENV         : ${env.NODE_ENV}`);
  console.log(`[worker] policy version   : ${policy.version}`);
  console.log(`[worker] kill switch      : ${policy.kill_switch}`);
  console.log(`[worker] timing strategy  : ${env.TIMING_STRATEGY}`);
  console.log(`[worker] demo time scale  : ${env.DEMO_TIME_SCALE}`);
  console.log(`[worker] diagnosis model  : ${env.LLM_MODEL_DIAGNOSIS}`);
  console.log(`[worker] guard model      : ${env.LLM_MODEL_GUARD}`);
  console.log(`[worker] attribution      : ${policy.attribution.window_hours}h window`);

  const { db } = createPooledDb(env.DATABASE_URL);
  const result = await db.execute<{ n: number }>(sql`SELECT 1 AS n`);
  console.log(`[worker] database         : reachable (SELECT 1 → ${result.rows[0]?.n ?? '?'})`);

  // `--once` drains the queue and exits, which is what CI and the completion
  // checks use. Without it the worker polls, which is how it runs on Railway.
  const runOnce = process.argv.includes('--once');
  const pending = await countPendingEvents(db);
  console.log(`[worker] pending events   : ${pending}`);

  if (runOnce) {
    const summary = await runIngestPass(db);
    reportIngest(summary);
    await closeAllPools();
    return;
  }

  console.log(`\n[worker] ingest loop started, polling every ${POLL_INTERVAL_MS / 1000}s`);
  console.log('[worker] diagnose / plan / schedule / execute land in Runs 3-5.');

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[worker] ${signal} received, finishing the current pass then exiting`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    const summary = await runIngestPass(db);
    if (summary.scanned > 0) reportIngest(summary);
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  await closeAllPools();
  console.log('[worker] stopped cleanly');
}

function reportIngest(summary: {
  scanned: number;
  casesCreated: number;
  signalsRecorded: number;
  skipped: number;
  failed: number;
  warnings: readonly string[];
}): void {
  console.log(
    `[ingest] scanned=${summary.scanned} cases=${summary.casesCreated} ` +
      `signals=${summary.signalsRecorded} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  // Nothing is silently discarded — every warning is surfaced.
  for (const warning of summary.warnings) {
    console.warn(`[ingest] ${warning}`);
  }
}

main().catch((error: unknown) => {
  console.error('[worker] FAILED TO START');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
