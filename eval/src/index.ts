/**
 * eval — the measurement harness. Scaffold only in Run 1; built in Run 7.
 *
 * What it will do (docs/EVAL_METHODOLOGY.md): run the same synthetic case batch
 * through three arms — do-nothing baseline, naive fixed retry, and the Reflow
 * agent — then write RESULTS.md.
 *
 * The claim this harness makes is that its numbers describe the system that
 * actually runs in production. That is only true because it imports the SAME
 * pure functions from @reflow/core that the live worker calls. Nothing in
 * `eval/` may reimplement a decision.
 */

import { getFullEnv, loadPolicy } from '@reflow/core';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

function main(): void {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });
  const env = getFullEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);

  console.log('[eval] scaffold — the harness is built in Run 7.');
  console.log(`[eval] policy version : ${policy.version}`);
  console.log(`[eval] timing strategy: ${env.TIMING_STRATEGY}`);
  console.log('[eval] arms planned   : do_nothing | naive_retry | reflow_agent');
  console.log('[eval] Reminder: every eval query filters is_synthetic = true.');
}

main();
