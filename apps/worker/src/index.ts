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

const repoRoot = resolve(import.meta.dirname, '../../..');

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

  console.log('\n[worker] Run 1 scaffold only — the recovery loop lands in Runs 2-5.');
  await closeAllPools();
}

main().catch((error: unknown) => {
  console.error('[worker] FAILED TO START');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
