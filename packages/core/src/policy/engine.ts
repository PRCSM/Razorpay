/**
 * The policy engine: root cause + case context → a `Plan`.
 *
 * A plan is a DECISION RECORD, not a queue entry (docs/DATABASE_DESIGN.md). It
 * carries what the agent intends, when, at what expected value and cost, and which
 * policy and model versions produced it — so any decision is reproducible months
 * later.
 *
 * The engine chooses the intervention and asks the timing strategy WHEN. It does
 * not run the guardrails: that is a separate, re-runnable chain, because the same
 * plan is re-gated at execution time in Run 5.
 *
 * PURE. `now`, the policy, and the strategy all arrive as parameters.
 */

import type { ActionType, CaseSource, Channel, PaymentMethod } from '../types/enums';
import type { RootCause } from '../diagnose/taxonomy';
import { isRootCause } from '../diagnose/taxonomy';
import type { DowntimeWindow } from '../diagnose/downtime';
import type { PolicyConfig } from './schema';
import {
  INTERVENTIONS,
  estimateCostPaise,
  interventionForAttempt,
  isContactAction,
} from './interventions';
import type { TimingDecision, TimingStrategy } from '../timing/strategy';

/** The case, as the engine needs it. Plain data, straight off `recovery_cases`. */
export interface PlanningCase {
  readonly id: string;
  readonly source: CaseSource;
  readonly rootCause: string | null;
  readonly causeBy: string | null;
  readonly amountPaise: number;
  readonly currency: string;
  readonly customerRef: string | null;
  readonly issuer: string | null;
  readonly method: PaymentMethod | null;
  readonly attemptCount: number;
}

export interface PlanningContext {
  readonly policy: PolicyConfig;
  readonly strategy: TimingStrategy;
  readonly demoTimeScale: number;
  /** From `recovery_cases.cause_by = 'downtime_signal'`. Enables downtime timing. */
  readonly downtimeWindow?: DowntimeWindow | null;
  /** Recorded on the plan when the LLM was involved in diagnosis. */
  readonly modelVersion?: string | null;
  /**
   * A registered DLT template id for the chosen channel. Required for SMS by
   * gate 7 — absent means the compliance gate will drop the plan, which is the
   * correct outcome rather than sending an unregistered message.
   */
  readonly dltTemplateId?: string | null;
}

/** The engine's output. Mirrors the insertable columns of `plans`. */
export interface PlanDraft {
  readonly caseId: string;
  readonly actionType: ActionType;
  readonly scheduledFor: Date;
  readonly channel: Channel | null;
  readonly templateId: string | null;
  readonly expectedP: number;
  readonly estCostPaise: number;
  readonly policyVersion: string;
  readonly modelVersion: string | null;
  /** Why this action, and why then. Persisted for the audit trail. */
  readonly rationale: string;
  readonly timing: TimingDecision;
  /** True when this is a re-check rather than a money action (open outage). */
  readonly recheckOnly: boolean;
  readonly isContact: boolean;
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: PlanDraft }
  | {
      readonly ok: false;
      /** Why no plan could be made. Always persisted — nothing is discarded. */
      readonly reason: 'undiagnosed' | 'unknown_cause' | 'ladder_exhausted' | 'invalid_cause';
      readonly detail: string;
    };

/**
 * Build a plan for one case.
 *
 * Refuses rather than guesses in three situations, each of which is a real state
 * the system reaches:
 *
 *  - the case has no diagnosis yet
 *  - the diagnosis is `unknown` (already an exception; planning would be inventing)
 *  - the intervention ladder is exhausted (the attempt cap has been reached)
 */
export function buildPlan(
  planningCase: PlanningCase,
  context: PlanningContext,
  now: Date,
): PlanOutcome {
  const cause = planningCase.rootCause;

  if (cause === null || cause === '') {
    return {
      ok: false,
      reason: 'undiagnosed',
      detail: 'case has no root_cause; run diagnosis before planning',
    };
  }
  if (cause === 'unknown') {
    return {
      ok: false,
      reason: 'unknown_cause',
      detail: 'root_cause is unknown; the case belongs to the exception list, not a plan',
    };
  }
  // Fail closed on a cause outside the taxonomy: a label we do not recognise must
  // never be planned against.
  if (!isRootCause(cause)) {
    return {
      ok: false,
      reason: 'invalid_cause',
      detail: `"${cause}" is not in the closed taxonomy; refusing to plan`,
    };
  }

  const typedCause: RootCause = cause;
  const attemptCount = Number.isInteger(planningCase.attemptCount)
    ? Math.max(0, planningCase.attemptCount)
    : 0;

  const intervention = interventionForAttempt(typedCause, attemptCount);
  if (!intervention) {
    return {
      ok: false,
      reason: 'ladder_exhausted',
      detail:
        `${typedCause}: ${INTERVENTIONS[typedCause].maxAttempts} attempt(s) allowed, ` +
        `${attemptCount} already made`,
    };
  }

  const timing = context.strategy.schedule(
    {
      rootCause: typedCause,
      issuer: planningCase.issuer,
      method: planningCase.method,
      attemptCount,
      salaryWindowDays: context.policy.timing.salary_window_days,
      demoTimeScale: context.demoTimeScale,
      downtimeWindow: context.downtimeWindow ?? null,
    },
    now,
  );

  /**
   * An open outage downgrades the action to a silent re-check.
   *
   * Retrying into a bank that is still down is guaranteed to fail and would spend
   * one of the three attempts gate 1 allows. `delayed_retry` with `recheckOnly`
   * marks the intent without contacting anyone.
   */
  const actionType: ActionType = timing.recheckOnly ? 'delayed_retry' : intervention.actionType;
  const isContact = timing.recheckOnly ? false : intervention.isContact;
  const channel: Channel = timing.recheckOnly ? 'none' : intervention.channel;

  // A DLT template is only meaningful for SMS. Gate 7 rejects an SMS without one.
  const templateId = channel === 'sms' ? (context.dltTemplateId ?? null) : null;

  const estCostPaise = timing.recheckOnly
    ? 0
    : estimateCostPaise(intervention, context.policy.costs);

  const rationale =
    `${INTERVENTIONS[typedCause].rationale} ` +
    `Attempt ${attemptCount + 1}/${INTERVENTIONS[typedCause].maxAttempts}: ` +
    `${actionType}${channel !== 'none' ? ` via ${channel}` : ''}. ${timing.reason}`;

  return {
    ok: true,
    plan: {
      caseId: planningCase.id,
      actionType,
      scheduledFor: timing.scheduledFor,
      channel,
      templateId,
      expectedP: clampProbability(timing.recheckOnly ? 0 : intervention.expectedP),
      estCostPaise,
      policyVersion: context.policy.version,
      modelVersion: context.modelVersion ?? null,
      rationale,
      timing,
      recheckOnly: timing.recheckOnly,
      isContact: isContact && isContactAction(actionType),
    },
  };
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Expected value of a plan, in paise: `amount × p − cost`.
 * Used by the dashboard and the cost-per-rupee metric. Not a gate — a negative
 * expected value is informative, not disqualifying.
 */
export function expectedValuePaise(plan: PlanDraft, amountPaise: number): number {
  if (!Number.isFinite(amountPaise) || amountPaise < 0) return 0;
  return Math.round(amountPaise * plan.expectedP) - plan.estCostPaise;
}
