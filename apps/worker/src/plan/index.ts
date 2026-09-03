/**
 * The plan stage: diagnosed cases → gated plans.
 *
 * Reads `recovery_cases` with a `root_cause` and no pending plan, builds a plan,
 * runs the guardrail chain, and persists BOTH the plan and every gate verdict —
 * including the plans that were dropped.
 *
 * docs/DATABASE_DESIGN.md: "Plans are kept even when dropped. A dropped plan with
 * its gate reasons is evidence the guardrails work, which makes it the most
 * interesting data in the system. Deleting them would erase that."
 *
 * All decision logic is in `packages/core`. This file loads state, calls pure
 * functions, and writes rows.
 */

import {
  buildPlan,
  runGuardrails,
  selectTimingStrategy,
  type BanditArm,
  type DowntimeWindow,
  type GatedPlan,
  type GateVerdict,
  type GuardrailState,
  type PlanDraft,
  type PolicyConfig,
  type ChainDisposition,
} from '@reflow/core';
import {
  actions,
  banditArms,
  exceptions,
  plans,
  recoveryCases,
  type PooledDb,
} from '@reflow/db';
import { and, asc, eq, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { loadRelevantDowntimeWindows } from '../ingest/downtime';

export interface PlanPassOptions {
  readonly batchSize?: number;
  readonly now?: () => Date;
  /** From `TIMING_STRATEGY`. */
  readonly timingStrategy?: 'static' | 'bandit' | undefined;
  /** Required for the bandit; injected so sampling is reproducible. */
  readonly random?: () => number;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface GateStat {
  readonly gate: string;
  readonly evaluated: number;
  readonly passed: number;
  readonly failed: number;
  readonly failedClosed: number;
}

export interface PlanPassSummary {
  readonly scanned: number;
  readonly plansWritten: number;
  readonly noPlan: number;
  readonly failed: number;
  readonly byDisposition: Readonly<Record<ChainDisposition, number>>;
  readonly byGate: readonly GateStat[];
  /** Which gate decided the outcome, when it was not `allow`. */
  readonly decidedBy: Readonly<Record<string, number>>;
  readonly byActionType: Readonly<Record<string, number>>;
  readonly byTimingBasis: Readonly<Record<string, number>>;
  readonly contactPlans: number;
  readonly terminalCases: number;
  /** Contact plans on a terminal case. MUST be zero. */
  readonly terminalContactPlans: number;
  readonly noPlanReasons: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

const EMPTY_DISPOSITIONS: Record<ChainDisposition, number> = {
  allow: 0,
  rescheduled: 0,
  downgraded: 0,
  escalated: 0,
  dropped: 0,
  stopped: 0,
};

/**
 * Contact actions already sent to each customer in the current IST day, counted
 * across ALL their cases — that cross-case count is what gate 3 needs.
 *
 * One grouped query rather than a query per case: at 500 cases the difference is
 * 1 round trip instead of 500.
 */
async function loadContactCountsByCustomer(
  db: PooledDb,
  since: Date,
): Promise<Map<string, number>> {
  const rows = await db.execute<{ customer_ref: string | null; n: string | number }>(sql`
    SELECT rc.customer_ref AS customer_ref, COUNT(*) AS n
    FROM actions a
    JOIN plans p ON p.id = a.plan_id
    JOIN recovery_cases rc ON rc.id = a.case_id
    WHERE a.executed_at >= ${since}
      AND a.status = 'success'
      AND p.action_type IN ('nudge', 'pre_debit_notice', 'promise_to_pay')
    GROUP BY rc.customer_ref
  `);

  const counts = new Map<string, number>();
  for (const row of rows.rows) {
    if (typeof row.customer_ref === 'string' && row.customer_ref !== '') {
      counts.set(row.customer_ref, Number(row.n));
    }
  }
  return counts;
}

/** The most recent successful action per case, for the cooling window. */
async function loadLastActionByCase(db: PooledDb): Promise<Map<string, Date>> {
  const rows = await db
    .select({ caseId: actions.caseId, executedAt: actions.executedAt })
    .from(actions)
    .where(isNotNull(actions.executedAt))
    .orderBy(asc(actions.executedAt));

  const last = new Map<string, Date>();
  for (const row of rows) {
    if (row.executedAt) last.set(row.caseId, row.executedAt);
  }
  return last;
}

/** When a pre-debit notice was last executed per case, for gate 7. */
async function loadPreDebitNoticeByCase(db: PooledDb): Promise<Map<string, Date>> {
  const rows = await db.execute<{ case_id: string; sent_at: Date | string }>(sql`
    SELECT a.case_id AS case_id, MAX(a.executed_at) AS sent_at
    FROM actions a
    JOIN plans p ON p.id = a.plan_id
    WHERE p.action_type = 'pre_debit_notice'
      AND a.status = 'success'
      AND a.executed_at IS NOT NULL
    GROUP BY a.case_id
  `);

  const map = new Map<string, Date>();
  for (const row of rows.rows) {
    map.set(row.case_id, new Date(row.sent_at as string));
  }
  return map;
}

/** Cases already flagged for prompt injection — gate 0 reads this. */
async function loadInjectionFlaggedCases(db: PooledDb): Promise<Set<string>> {
  const rows = await db.execute<{ case_id: string }>(sql`
    SELECT DISTINCT case_id FROM exceptions
    WHERE reason LIKE 'injection_suspected%' AND case_id IS NOT NULL
  `);
  return new Set(rows.rows.map((r) => r.case_id));
}

async function loadBanditArms(db: PooledDb): Promise<BanditArm[]> {
  const rows = await db
    .select({
      bucketKey: banditArms.bucketKey,
      arm: banditArms.arm,
      alpha: banditArms.alpha,
      beta: banditArms.beta,
    })
    .from(banditArms);
  return rows.map((r) => ({
    bucketKey: r.bucketKey,
    arm: r.arm,
    alpha: r.alpha,
    beta: r.beta,
  }));
}

/**
 * Plan one batch.
 *
 * A case gets a plan only if it has a diagnosis and no pending plan already.
 * Re-running is therefore safe and idempotent.
 */
export async function runPlanPass(
  db: PooledDb,
  policy: PolicyConfig,
  demoTimeScale: number,
  options: PlanPassOptions = {},
): Promise<PlanPassSummary> {
  const batchSize = options.batchSize ?? 1000;
  const now = options.now ?? (() => new Date());
  const startOfWindow = new Date(now().getTime() - 24 * 60 * 60 * 1000);

  const pending = await db
    .select({
      id: recoveryCases.id,
      source: recoveryCases.source,
      rootCause: recoveryCases.rootCause,
      causeBy: recoveryCases.causeBy,
      amountPaise: recoveryCases.amountPaise,
      currency: recoveryCases.currency,
      customerRef: recoveryCases.customerRef,
      issuer: recoveryCases.issuer,
      method: recoveryCases.method,
      attemptCount: recoveryCases.attemptCount,
      openedAt: recoveryCases.openedAt,
    })
    .from(recoveryCases)
    .where(
      and(
        isNotNull(recoveryCases.rootCause),
        ne(recoveryCases.rootCause, 'unknown'),
        // Skip cases that already have a plan waiting.
        sql`NOT EXISTS (SELECT 1 FROM plans p WHERE p.case_id = ${recoveryCases.id} AND p.status = 'pending')`,
      ),
    )
    .orderBy(asc(recoveryCases.openedAt))
    .limit(batchSize);

  if (pending.length === 0) return emptySummary();

  const [downtimeWindows, contactCounts, lastActions, preDebitNotices, injectionFlagged, arms] =
    await Promise.all([
      loadRelevantDowntimeWindows(db, new Date(now().getTime() - 30 * 24 * 60 * 60 * 1000)),
      loadContactCountsByCustomer(db, startOfWindow),
      loadLastActionByCase(db),
      loadPreDebitNoticeByCase(db),
      loadInjectionFlaggedCases(db),
      loadBanditArms(db),
    ]);

  const strategy = selectTimingStrategy({
    requested: options.timingStrategy,
    policy,
    arms,
    ...(options.random ? { random: options.random } : {}),
  });

  const byDisposition: Record<ChainDisposition, number> = { ...EMPTY_DISPOSITIONS };
  const gateStats = new Map<string, GateStat>();
  const decidedBy: Record<string, number> = {};
  const byActionType: Record<string, number> = {};
  const byTimingBasis: Record<string, number> = {};
  const noPlanReasons: Record<string, number> = {};
  const warnings: string[] = [];

  let plansWritten = 0;
  let noPlan = 0;
  let failed = 0;
  let contactPlans = 0;
  let terminalCases = 0;
  let terminalContactPlans = 0;

  const terminalSet = new Set(policy.gates.terminal_check.causes);

  for (const [index, row] of pending.entries()) {
    try {
      const at = now();
      const isTerminal = terminalSet.has(row.rootCause ?? '');
      if (isTerminal) terminalCases += 1;

      // The downtime window only applies when diagnosis actually used it.
      const window: DowntimeWindow | null =
        row.causeBy === 'downtime_signal'
          ? (findWindowFor(downtimeWindows, row.issuer, row.method, row.openedAt) ?? null)
          : null;

      const outcome = buildPlan(
        {
          id: row.id,
          source: row.source,
          rootCause: row.rootCause,
          causeBy: row.causeBy,
          amountPaise: row.amountPaise,
          currency: row.currency,
          customerRef: row.customerRef,
          issuer: row.issuer,
          method: row.method,
          attemptCount: row.attemptCount,
        },
        {
          policy,
          strategy,
          demoTimeScale,
          downtimeWindow: window,
          // A DLT template is available for SMS in this deployment. Nothing is
          // actually sent (docs/ARCHITECTURE.md), but the id must exist for
          // gate 7 to permit an SMS at all.
          dltTemplateId: 'DLT_REFLOW_RECOVERY_01',
        },
        at,
      );

      if (!outcome.ok) {
        noPlan += 1;
        noPlanReasons[outcome.reason] = (noPlanReasons[outcome.reason] ?? 0) + 1;
        continue;
      }

      const draft: PlanDraft = outcome.plan;

      const state: GuardrailState = {
        caseId: row.id,
        rootCause: row.rootCause,
        amountPaise: row.amountPaise,
        customerRef: row.customerRef,
        method: row.method,
        attemptCount: row.attemptCount,
        lastActionAt: lastActions.get(row.id) ?? null,
        contactsTodayForCustomer: row.customerRef
          ? (contactCounts.get(row.customerRef) ?? 0)
          : 0,
        injectionFlagged: injectionFlagged.has(row.id),
        preDebitNoticeSentAt: preDebitNotices.get(row.id) ?? null,
        isMandateRepresentment: row.source === 'mandate',
      };

      const gated: GatedPlan = {
        actionType: draft.actionType,
        scheduledFor: draft.scheduledFor,
        channel: draft.channel,
        templateId: draft.templateId,
        estCostPaise: draft.estCostPaise,
        isContact: draft.isContact,
      };

      const chain = runGuardrails(gated, state, policy, at);

      // ---- statistics ---------------------------------------------------
      byDisposition[chain.disposition] += 1;
      if (chain.decidedBy) {
        decidedBy[chain.decidedBy] = (decidedBy[chain.decidedBy] ?? 0) + 1;
      }
      for (const verdict of chain.results) {
        recordGate(gateStats, verdict);
      }
      byTimingBasis[draft.timing.basis] = (byTimingBasis[draft.timing.basis] ?? 0) + 1;

      const finalPlan = chain.plan;
      const finalActionType = finalPlan?.actionType ?? 'stop';
      byActionType[finalActionType] = (byActionType[finalActionType] ?? 0) + 1;

      if (finalPlan?.isContact === true) {
        contactPlans += 1;
        // The invariant TASK 6 exists to protect.
        if (isTerminal) terminalContactPlans += 1;
      }

      // ---- persist ------------------------------------------------------
      // The plan row, its gate verdicts, and the case status move together.
      await db.transaction(async (tx) => {
        await tx.insert(plans).values({
          caseId: row.id,
          actionType: finalActionType,
          scheduledFor: finalPlan?.scheduledFor ?? draft.scheduledFor,
          channel: finalPlan?.channel ?? 'none',
          templateId: finalPlan?.templateId ?? null,
          expectedP: draft.expectedP,
          estCostPaise: finalPlan?.estCostPaise ?? draft.estCostPaise,
          policyVersion: draft.policyVersion,
          modelVersion: draft.modelVersion,
          guardrailResults: chain.results as GateVerdict[],
          status: dispositionToPlanStatus(chain.disposition),
        });

        // A stopped or dropped plan closes the case rather than leaving it open
        // forever, and records why in the exception list.
        if (chain.disposition === 'stopped' || chain.disposition === 'dropped') {
          await tx
            .update(recoveryCases)
            .set({ status: 'stopped', closedAt: at })
            .where(eq(recoveryCases.id, row.id));

          await tx.insert(exceptions).values({
            caseId: row.id,
            reason: `guardrail_${chain.disposition}: ${chain.summary}`,
            // A policy stop is a decision, not something a human must resolve.
            // A fail-closed block IS, because it means data was missing.
            needsHuman: chain.anyFailedClosed || chain.disposition === 'dropped',
          });
        } else {
          await tx
            .update(recoveryCases)
            .set({ status: 'planned' })
            .where(eq(recoveryCases.id, row.id));
        }
      });

      plansWritten += 1;

      if (options.onProgress && (index + 1) % 100 === 0) {
        options.onProgress(index + 1, pending.length);
      }
    } catch (error) {
      failed += 1;
      warnings.push(
        `FAILED case ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    scanned: pending.length,
    plansWritten,
    noPlan,
    failed,
    byDisposition,
    byGate: [...gateStats.values()],
    decidedBy,
    byActionType,
    byTimingBasis,
    contactPlans,
    terminalCases,
    terminalContactPlans,
    noPlanReasons,
    warnings,
  };
}

function findWindowFor(
  windows: readonly DowntimeWindow[],
  issuer: string | null,
  method: string | null,
  at: Date,
): DowntimeWindow | undefined {
  return windows.find((w) => {
    if (w.issuer !== null && w.issuer !== (issuer ?? '').toLowerCase()) return false;
    if (w.method !== null && w.method !== method) return false;
    if (at.getTime() < w.startedAt.getTime()) return false;
    if (w.resolvedAt !== null && at.getTime() > w.resolvedAt.getTime()) return false;
    return true;
  });
}

function recordGate(stats: Map<string, GateStat>, verdict: GateVerdict): void {
  const existing = stats.get(verdict.gate) ?? {
    gate: verdict.gate,
    evaluated: 0,
    passed: 0,
    failed: 0,
    failedClosed: 0,
  };
  stats.set(verdict.gate, {
    gate: verdict.gate,
    evaluated: existing.evaluated + 1,
    passed: existing.passed + (verdict.passed ? 1 : 0),
    failed: existing.failed + (verdict.passed ? 0 : 1),
    failedClosed: existing.failedClosed + (verdict.failedClosed === true ? 1 : 0),
  });
}

/** Chain disposition → the `plans.status` vocabulary. */
function dispositionToPlanStatus(
  disposition: ChainDisposition,
): 'pending' | 'dropped' | 'downgraded' {
  switch (disposition) {
    case 'stopped':
    case 'dropped':
      return 'dropped';
    case 'downgraded':
    case 'escalated':
      return 'downgraded';
    default:
      // `allow` and `rescheduled` are both executable, so both stay pending.
      return 'pending';
  }
}

function emptySummary(): PlanPassSummary {
  return {
    scanned: 0,
    plansWritten: 0,
    noPlan: 0,
    failed: 0,
    byDisposition: { ...EMPTY_DISPOSITIONS },
    byGate: [],
    decidedBy: {},
    byActionType: {},
    byTimingBasis: {},
    contactPlans: 0,
    terminalCases: 0,
    terminalContactPlans: 0,
    noPlanReasons: {},
    warnings: [],
  };
}

/** Cases with a diagnosis but no plan yet. */
export async function countUnplannedCases(db: PooledDb): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    SELECT COUNT(*) AS n FROM recovery_cases rc
    WHERE rc.root_cause IS NOT NULL AND rc.root_cause <> 'unknown'
      AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.case_id = rc.id)
  `);
  return Number(result.rows[0]?.n ?? 0);
}

export { isNull, gte };
