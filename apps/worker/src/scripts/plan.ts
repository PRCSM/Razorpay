/**
 * Run the plan stage.
 *
 *   pnpm plan            plan every diagnosed case without a pending plan
 *   pnpm plan --reset    delete existing plans and guardrail exceptions, re-plan
 *
 * Prints the gate summary: how many plans each gate blocked, downgraded, or
 * rescheduled, and how many blocks were fail-closed rather than ordinary policy
 * refusals. Those two mean different things to an operator.
 */

import { getWorkerEnv, loadPolicy } from '@reflow/core';
import { closeAllPools, createPooledDb, exceptions, plans } from '@reflow/db';
import { like, sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { countUnplannedCases, runPlanPass } from '../plan/index';

const repoRoot = resolve(import.meta.dirname, '../../../..');

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const reset = process.argv.includes('--reset');

  const env = getWorkerEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);

  console.log(`[plan] policy ${policy.version} · kill_switch=${policy.kill_switch}`);
  console.log(`[plan] timing strategy: ${env.TIMING_STRATEGY} · DEMO_TIME_SCALE=${env.DEMO_TIME_SCALE}`);

  const { db } = createPooledDb(env.DATABASE_URL, { max: 2 });

  try {
    if (reset) {
      const clearedPlans = await db.delete(plans).returning({ id: plans.id });
      // Only the exceptions this stage created; diagnosis exceptions stay.
      const clearedExceptions = await db
        .delete(exceptions)
        .where(like(exceptions.reason, 'guardrail_%'))
        .returning({ id: exceptions.id });
      // Re-open cases the guardrails had closed.
      const reopened = await db.execute(sql`
        UPDATE recovery_cases
        SET status = 'diagnosed', closed_at = NULL
        WHERE root_cause IS NOT NULL AND root_cause <> 'unknown'
        RETURNING id
      `);
      console.log(
        `[plan] --reset: cleared ${clearedPlans.length} plan(s), ` +
          `${clearedExceptions.length} guardrail exception(s), reopened ${reopened.rows.length} case(s)`,
      );
    }

    const unplanned = await countUnplannedCases(db);
    console.log(`[plan] cases awaiting a plan: ${unplanned}`);

    const started = Date.now();
    const summary = await runPlanPass(db, policy, env.DEMO_TIME_SCALE, {
      timingStrategy: env.TIMING_STRATEGY,
      // A fixed seed keeps a bandit run reproducible. Never Math.random().
      random: makeSeededRandom(42),
      onProgress: (done, total) => console.log(`[plan] ${done}/${total}`),
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n=== PLANNING SUMMARY ===');
    console.log(`scanned        : ${summary.scanned}`);
    console.log(`plans written  : ${summary.plansWritten}`);
    console.log(`no plan        : ${summary.noPlan}`);
    console.log(`failed         : ${summary.failed}`);
    console.log(`elapsed        : ${elapsed}s`);

    console.log('\n-- disposition --');
    for (const [key, count] of Object.entries(summary.byDisposition)) {
      console.log(`  ${key.padEnd(14)} ${pad(count, 5)}`);
    }

    console.log('\n=== GATE SUMMARY ===');
    console.log('gate                evaluated  passed  failed  fail-closed');
    // Print in the policy.yaml order, not in map-insertion order.
    const order = [
      'injection_screen',
      'attempt_cap',
      'cooling_window',
      'contact_cap',
      'quiet_hours',
      'terminal_check',
      'amount_ceiling',
      'compliance',
    ];
    for (const gate of order) {
      const stat = summary.byGate.find((g) => g.gate === gate);
      if (!stat) {
        console.log(`  ${gate.padEnd(18)} ${pad(0, 9)} ${pad(0, 7)} ${pad(0, 7)} ${pad(0, 12)}`);
        continue;
      }
      console.log(
        `  ${gate.padEnd(18)} ${pad(stat.evaluated, 9)} ${pad(stat.passed, 7)} ` +
          `${pad(stat.failed, 7)} ${pad(stat.failedClosed, 12)}`,
      );
    }

    console.log('\n-- outcome decided by --');
    if (Object.keys(summary.decidedBy).length === 0) {
      console.log('  (nothing was blocked, downgraded or rescheduled)');
    }
    for (const [gate, count] of Object.entries(summary.decidedBy).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${gate.padEnd(18)} ${pad(count, 5)}`);
    }

    console.log('\n-- final action types --');
    for (const [action, count] of Object.entries(summary.byActionType).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${action.padEnd(18)} ${pad(count, 5)}`);
    }

    console.log('\n-- timing basis --');
    for (const [basis, count] of Object.entries(summary.byTimingBasis).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${basis.padEnd(22)} ${pad(count, 5)}`);
    }

    console.log('\n-- the invariant --');
    console.log(`  terminal cases            : ${summary.terminalCases}`);
    console.log(`  contact plans (all cases) : ${summary.contactPlans}`);
    console.log(
      `  contact plans on TERMINAL : ${summary.terminalContactPlans}  ` +
        `${summary.terminalContactPlans === 0 ? '<- correct, must be 0' : '<- VIOLATION'}`,
    );

    if (Object.keys(summary.noPlanReasons).length > 0) {
      console.log('\n-- no plan produced --');
      for (const [reason, count] of Object.entries(summary.noPlanReasons)) {
        console.log(`  ${reason.padEnd(20)} ${pad(count, 5)}`);
      }
    }

    for (const warning of summary.warnings) console.warn(`[plan] ${warning}`);

    // ---- row-level confirmation, not a trust-the-counter claim ------------
    const persisted = await db.execute<{ status: string; n: string | number }>(sql`
      SELECT status, COUNT(*) AS n FROM plans GROUP BY status ORDER BY n DESC
    `);
    console.log('\n[plan] persisted plans.status in Neon:');
    for (const row of persisted.rows) {
      console.log(`  ${String(row.status).padEnd(12)} ${Number(row.n)}`);
    }

    const gateRows = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n FROM plans
      WHERE jsonb_array_length(guardrail_results) = 8
    `);
    console.log(
      `[plan] plans with all 8 gate verdicts persisted: ${Number(gateRows.rows[0]?.n ?? 0)}`,
    );

    const terminalContact = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n
      FROM plans p JOIN recovery_cases rc ON rc.id = p.case_id
      WHERE rc.root_cause IN ('fraud_flag','chargeback','customer_opt_out','mandate_revoked')
        AND p.action_type IN ('nudge','pre_debit_notice','promise_to_pay')
        AND p.status <> 'dropped'
    `);
    const violations = Number(terminalContact.rows[0]?.n ?? 0);
    console.log(
      `[plan] DB CHECK — executable contact plans on terminal cases: ${violations}` +
        `${violations === 0 ? '  (correct)' : '  <-- INVARIANT VIOLATED'}`,
    );

    const unplannedAfter = await countUnplannedCases(db);
    console.log(`[plan] cases still without a plan: ${unplannedAfter}`);

    if (violations > 0 || summary.terminalContactPlans > 0) {
      process.exitCode = 1;
    }
  } finally {
    await closeAllPools();
  }
}

/**
 * mulberry32, matching the eval generator.
 *
 * The bandit must be reproducible: `Math.random()` would make two identical runs
 * disagree and the arm comparison in RESULTS.md would be noise.
 */
function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((error: unknown) => {
  console.error('[plan] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
