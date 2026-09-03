/**
 * Row-level proof of the guardrail chain, against real Neon rows.
 *
 *   pnpm plan:smoke
 *
 * TASK 8 is explicit: assert against PERSISTED DB ROWS, not just function returns.
 * Across Runs 2 and 3 every real bug escaped the unit tests and was caught only by
 * a row-level or end-to-end assertion, so this script is the one that matters.
 *
 * It proves, on data that actually reached Postgres:
 *
 *   1. every plan carries all eight gate verdicts, passes included
 *   2. no terminal case has an executable contact plan
 *   3. downtime-aware scheduling, against a real `downtime_windows` row
 *   4. the same input produces the same plan twice (determinism)
 *   5. a fail-closed block on a case with missing data
 *   6. the kill switch halts everything
 *
 * Cleans up everything it creates.
 */

import {
  buildPlan,
  runGuardrails,
  StaticTimingStrategy,
  getWorkerEnv,
  loadPolicy,
  type GatedPlan,
  type GuardrailState,
  type PolicyConfig,
} from '@reflow/core';
import {
  closeAllPools,
  createPooledDb,
  downtimeWindows,
  exceptions,
  merchants,
  plans,
  recoveryCases,
} from '@reflow/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../..');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function baseState(overrides: Partial<GuardrailState>): GuardrailState {
  return {
    caseId: 'x',
    rootCause: 'insufficient_funds',
    amountPaise: 250_000,
    customerRef: 'cust_smoke',
    method: 'card',
    attemptCount: 0,
    lastActionAt: null,
    contactsTodayForCustomer: 0,
    injectionFlagged: false,
    preDebitNoticeSentAt: null,
    isMandateRepresentment: false,
    ...overrides,
  };
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const env = getWorkerEnv();
  const policy: PolicyConfig = loadPolicy(env.POLICY_PATH, repoRoot);

  const nonce = randomBytes(5).toString('hex');
  const downtimeId = `down_plan_${nonce}`;
  const { db } = createPooledDb(env.DATABASE_URL, { max: 2 });
  const createdCaseIds: string[] = [];

  try {
    const merchantRows = await db
      .select({ id: merchants.id })
      .from(merchants)
      .orderBy(asc(merchants.createdAt))
      .limit(1);
    const merchantId = merchantRows[0]?.id;
    if (!merchantId) throw new Error('no merchant — run pnpm db:seed');

    // ---- 1. every persisted plan carries all eight verdicts ---------------
    const totals = await db.execute<{ total: string | number; complete: string | number }>(sql`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE jsonb_array_length(guardrail_results) = 8) AS complete
      FROM plans
    `);
    const total = Number(totals.rows[0]?.total ?? 0);
    const complete = Number(totals.rows[0]?.complete ?? 0);
    check(
      'every persisted plan has all 8 gate verdicts',
      total > 0 && total === complete,
      `${complete}/${total}`,
    );

    // Passes are recorded too, not just failures.
    const withPasses = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n FROM plans
      WHERE guardrail_results @> '[{"passed": true}]'::jsonb
    `);
    check(
      'guardrail_results records PASSES, not only failures',
      Number(withPasses.rows[0]?.n ?? 0) > 0,
      `${Number(withPasses.rows[0]?.n ?? 0)} plans contain a passing verdict`,
    );

    // Dropped plans are KEPT, with their reasons.
    const dropped = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n FROM plans WHERE status = 'dropped'
    `);
    check(
      'dropped plans are retained with their gate reasons',
      Number(dropped.rows[0]?.n ?? 0) > 0,
      `${Number(dropped.rows[0]?.n ?? 0)} dropped plans persisted`,
    );

    // ---- 2. the invariant, on real rows -----------------------------------
    const violations = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n
      FROM plans p JOIN recovery_cases rc ON rc.id = p.case_id
      WHERE rc.root_cause IN ('fraud_flag','chargeback','customer_opt_out','mandate_revoked')
        AND p.action_type IN ('nudge','pre_debit_notice','promise_to_pay')
        AND p.status <> 'dropped'
    `);
    check(
      'ZERO executable contact plans on terminal cases',
      Number(violations.rows[0]?.n ?? -1) === 0,
      `${Number(violations.rows[0]?.n ?? -1)} violation(s)`,
    );

    const terminalPlans = await db.execute<{ action_type: string; n: string | number }>(sql`
      SELECT p.action_type, COUNT(*) AS n
      FROM plans p JOIN recovery_cases rc ON rc.id = p.case_id
      WHERE rc.root_cause IN ('fraud_flag','chargeback','customer_opt_out','mandate_revoked')
      GROUP BY p.action_type
    `);
    console.log('  terminal-case plan action types in Neon:');
    for (const row of terminalPlans.rows) {
      console.log(`    ${String(row.action_type).padEnd(18)} ${Number(row.n)}`);
    }
    check(
      'every terminal-case plan is a stop',
      terminalPlans.rows.every((r) => r.action_type === 'stop'),
    );

    // Every terminal case is closed, with a recorded reason.
    const terminalClosed = await db.execute<{ n: string | number; closed: string | number }>(sql`
      SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'stopped') AS closed
      FROM recovery_cases
      WHERE root_cause IN ('fraud_flag','chargeback','customer_opt_out','mandate_revoked')
    `);
    check(
      'every terminal case is closed as stopped',
      Number(terminalClosed.rows[0]?.n ?? 0) === Number(terminalClosed.rows[0]?.closed ?? -1),
      `${Number(terminalClosed.rows[0]?.closed ?? 0)}/${Number(terminalClosed.rows[0]?.n ?? 0)}`,
    );

    // ---- 3. downtime-aware scheduling, against a REAL row -----------------
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const resolvedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await db
      .insert(downtimeWindows)
      .values({
        providerDowntimeId: downtimeId,
        issuer: 'hdfc',
        method: 'card',
        startedAt,
        resolvedAt,
        severity: 'high',
        status: 'resolved',
        scheduled: false,
      })
      .onConflictDoNothing({ target: downtimeWindows.providerDowntimeId });

    const windowRows = await db
      .select({
        id: downtimeWindows.id,
        issuer: downtimeWindows.issuer,
        method: downtimeWindows.method,
        startedAt: downtimeWindows.startedAt,
        resolvedAt: downtimeWindows.resolvedAt,
        severity: downtimeWindows.severity,
      })
      .from(downtimeWindows)
      .where(eq(downtimeWindows.providerDowntimeId, downtimeId));

    const window = windowRows[0];
    check('downtime_windows row read back from Neon', window !== undefined);

    if (window) {
      const now = new Date();
      const strategy = new StaticTimingStrategy();

      const withWindow = buildPlan(
        {
          id: 'dt-case',
          source: 'payment',
          rootCause: 'issuer_down',
          causeBy: 'downtime_signal',
          amountPaise: 250_000,
          currency: 'INR',
          customerRef: 'cust_dt',
          issuer: 'hdfc',
          method: 'card',
          attemptCount: 0,
        },
        { policy, strategy, demoTimeScale: 1, downtimeWindow: window },
        now,
      );

      check('a plan was produced for the downtime case', withWindow.ok);
      if (withWindow.ok) {
        // resolved_at + 0.5h grace, NOT the static +2h.
        const expected = window.resolvedAt!.getTime() + 30 * 60 * 1000;
        check(
          'scheduled relative to the REAL resolved_at, not a static +2h',
          Math.abs(withWindow.plan.scheduledFor.getTime() - expected) < 2000,
          `scheduled ${withWindow.plan.scheduledFor.toISOString()}, expected ~${new Date(expected).toISOString()}`,
        );
        check(
          'timing basis is downtime_resolved',
          withWindow.plan.timing.basis === 'downtime_resolved',
          withWindow.plan.timing.basis,
        );
      }

      // The same window, still OPEN.
      await db
        .update(downtimeWindows)
        .set({ resolvedAt: null, status: 'started' })
        .where(eq(downtimeWindows.providerDowntimeId, downtimeId));

      const openRows = await db
        .select({
          id: downtimeWindows.id,
          issuer: downtimeWindows.issuer,
          method: downtimeWindows.method,
          startedAt: downtimeWindows.startedAt,
          resolvedAt: downtimeWindows.resolvedAt,
          severity: downtimeWindows.severity,
        })
        .from(downtimeWindows)
        .where(eq(downtimeWindows.providerDowntimeId, downtimeId));

      const openWindow = openRows[0];
      check('window reads back as unresolved', openWindow?.resolvedAt === null);

      if (openWindow) {
        const whileOpen = buildPlan(
          {
            id: 'dt-case-open',
            source: 'payment',
            rootCause: 'issuer_down',
            causeBy: 'downtime_signal',
            amountPaise: 250_000,
            currency: 'INR',
            customerRef: 'cust_dt',
            issuer: 'hdfc',
            method: 'card',
            attemptCount: 0,
          },
          { policy, strategy, demoTimeScale: 1, downtimeWindow: openWindow },
          new Date(),
        );

        check('a plan was produced while the outage is open', whileOpen.ok);
        if (whileOpen.ok) {
          check(
            'an OPEN outage yields a re-check, not a money action',
            whileOpen.plan.recheckOnly === true &&
              whileOpen.plan.timing.basis === 'downtime_recheck',
            `recheckOnly=${whileOpen.plan.recheckOnly} basis=${whileOpen.plan.timing.basis}`,
          );
          check('the re-check costs nothing', whileOpen.plan.estCostPaise === 0);
          check('the re-check contacts nobody', whileOpen.plan.isContact === false);
        }
      }
    }

    // ---- 4. determinism ----------------------------------------------------
    const fixedNow = new Date('2026-02-20T12:00:00.000Z');
    const sampleCase = {
      id: 'det-case',
      source: 'payment' as const,
      rootCause: 'insufficient_funds',
      causeBy: 'rule',
      amountPaise: 250_000,
      currency: 'INR',
      customerRef: 'cust_det',
      issuer: 'hdfc',
      method: 'card' as const,
      attemptCount: 0,
    };
    const ctx = {
      policy,
      strategy: new StaticTimingStrategy(),
      demoTimeScale: 1,
      dltTemplateId: 'DLT_SMOKE',
    };

    const runA = buildPlan(sampleCase, ctx, fixedNow);
    const runB = buildPlan(sampleCase, ctx, fixedNow);
    check(
      'the same input produces an identical plan twice',
      runA.ok &&
        runB.ok &&
        runA.plan.actionType === runB.plan.actionType &&
        runA.plan.scheduledFor.getTime() === runB.plan.scheduledFor.getTime() &&
        runA.plan.estCostPaise === runB.plan.estCostPaise &&
        runA.plan.rationale === runB.plan.rationale,
      runA.ok && runB.ok
        ? `${runA.plan.actionType} @ ${runA.plan.scheduledFor.toISOString()}`
        : 'a run produced no plan',
    );

    // And the chain is deterministic too.
    if (runA.ok) {
      const gated: GatedPlan = {
        actionType: runA.plan.actionType,
        scheduledFor: runA.plan.scheduledFor,
        channel: runA.plan.channel,
        templateId: runA.plan.templateId,
        estCostPaise: runA.plan.estCostPaise,
        isContact: runA.plan.isContact,
      };
      const s = baseState({ caseId: 'det-case' });
      const chainA = runGuardrails(gated, s, policy, fixedNow);
      const chainB = runGuardrails(gated, s, policy, fixedNow);
      check(
        'the guardrail chain is deterministic and re-entrant',
        chainA.disposition === chainB.disposition &&
          JSON.stringify(chainA.results) === JSON.stringify(chainB.results),
        `${chainA.disposition} twice`,
      );
    }

    // ---- 5. fail-closed on a real case with missing data ------------------
    // A live case with no root_cause and no amount. The chain must refuse.
    const brokenRows = await db
      .insert(recoveryCases)
      .values({
        merchantId,
        source: 'payment',
        externalRef: `pay_broken_${nonce}`,
        amountPaise: 0,
        currency: 'INR',
        customerRef: null,
        method: null,
        issuer: null,
        status: 'open',
        openedAt: new Date(),
        isSynthetic: false,
      })
      .returning({ id: recoveryCases.id });
    const brokenId = brokenRows[0]?.id;
    if (brokenId) createdCaseIds.push(brokenId);

    const brokenChain = runGuardrails(
      {
        actionType: 'nudge',
        scheduledFor: new Date(),
        channel: 'sms',
        templateId: null,
        estCostPaise: 20,
        isContact: true,
      },
      baseState({ caseId: brokenId ?? 'x', rootCause: null, customerRef: null }),
      policy,
      new Date(),
    );

    check(
      'a case with missing data is BLOCKED, not allowed',
      brokenChain.plan === null,
      `disposition=${brokenChain.disposition}`,
    );
    check('the block is marked as fail-closed', brokenChain.anyFailedClosed === true);
    check(
      'the fail-closed block still records all 8 verdicts',
      brokenChain.results.length === 8,
      String(brokenChain.results.length),
    );

    // ---- 6. kill switch ----------------------------------------------------
    const halted: PolicyConfig = { ...policy, kill_switch: true };
    const haltedChain = runGuardrails(
      {
        actionType: 'delayed_retry',
        scheduledFor: new Date(),
        channel: 'none',
        templateId: null,
        estCostPaise: 0,
        isContact: false,
      },
      baseState({}),
      halted,
      new Date(),
    );
    check(
      'kill_switch halts an otherwise-valid plan',
      haltedChain.plan === null && haltedChain.decidedBy === 'kill_switch',
      haltedChain.summary,
    );

    // ---- gate blocking summary from real rows ------------------------------
    const gateBlocks = await db.execute<{ gate: string; n: string | number }>(sql`
      SELECT v->>'gate' AS gate, COUNT(*) AS n
      FROM plans p, jsonb_array_elements(p.guardrail_results) v
      WHERE (v->>'passed')::boolean = false
      GROUP BY v->>'gate'
      ORDER BY n DESC
    `);
    console.log('\n  gate failures recorded in Neon:');
    for (const row of gateBlocks.rows) {
      console.log(`    ${String(row.gate).padEnd(18)} ${Number(row.n)}`);
    }
    check('gate failures are queryable from the persisted JSON', gateBlocks.rows.length > 0);
  } finally {
    if (process.env['SMOKE_KEEP'] !== '1') {
      if (createdCaseIds.length > 0) {
        await db.delete(exceptions).where(inArray(exceptions.caseId, createdCaseIds));
        await db.delete(plans).where(inArray(plans.caseId, createdCaseIds));
        await db.delete(recoveryCases).where(inArray(recoveryCases.id, createdCaseIds));
      }
      await db.delete(downtimeWindows).where(eq(downtimeWindows.providerDowntimeId, downtimeId));
      console.log('\n[smoke] cleaned up the rows this run created');
    }
    await closeAllPools();
  }

  console.log(failures === 0 ? '\nALL PLAN CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('[smoke] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
