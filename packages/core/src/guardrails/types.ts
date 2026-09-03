/**
 * Guardrail chain types.
 *
 * Every gate returns `{ gate, passed, reason }` and ALL results persist to
 * `plans.guardrail_results` — passes included, not only failures. A dropped plan
 * with its gate reasons is the evidence the guardrails work, which makes it the
 * most interesting data in the system (docs/DATABASE_DESIGN.md).
 */

import type { ActionType, Channel, GateName, PaymentMethod } from '../types/enums';

/** What a gate does when it fails, from policy.yaml `on_fail`. */
export type OnFailAction =
  | 'stop_case'
  | 'reschedule_to_boundary'
  | 'downgrade_to_non_contact'
  | 'reschedule_to_window_open'
  | 'escalate_human'
  | 'drop_and_log'
  | 'flag_and_skip_llm';

/** One gate's verdict. Persisted verbatim. */
export interface GateVerdict {
  readonly gate: GateName;
  readonly passed: boolean;
  readonly reason: string;
  /** Present only on failure. Drives what happens to the plan. */
  readonly onFail?: OnFailAction;
  /** True when the gate blocked because an input was missing or malformed. */
  readonly failedClosed?: boolean;
}

/**
 * Everything the chain needs, supplied by the caller.
 *
 * TASK 7 — re-entrancy. All state arrives as arguments: no caching, no hidden
 * clock, no I/O. `runGuardrails(plan, state, now)` is callable at planning time and
 * again immediately before execution, and the second call may legitimately reach a
 * different verdict because the state has moved on. That is the point.
 */
export interface GuardrailState {
  readonly caseId: string;
  readonly rootCause: string | null;
  readonly amountPaise: number;
  readonly customerRef: string | null;
  readonly method: PaymentMethod | null;
  /** Attempts already made on this case. */
  readonly attemptCount: number;
  /** When the last action on this case executed. null = none yet. */
  readonly lastActionAt: Date | null;
  /**
   * Contact actions already sent to this customer in the current IST day,
   * counted ACROSS ALL their cases. A customer with three failed payments must
   * not receive nine messages.
   */
  readonly contactsTodayForCustomer: number;
  /** True when gate 0 flagged this case's text as an injection attempt. */
  readonly injectionFlagged: boolean;
  /**
   * When a pre-debit notice was sent for this mandate. Gate 7 requires one
   * before a re-presentment, with the lead time from policy.yaml.
   */
  readonly preDebitNoticeSentAt: Date | null;
  /** True when the case is a mandate debit — gate 7's notice rule applies. */
  readonly isMandateRepresentment: boolean;
}

/** The plan fields the chain inspects. A subset of `PlanDraft`. */
export interface GatedPlan {
  readonly actionType: ActionType;
  readonly scheduledFor: Date;
  readonly channel: Channel | null;
  readonly templateId: string | null;
  readonly estCostPaise: number;
  readonly isContact: boolean;
}

/** What the chain decided to do with the plan. */
export type ChainDisposition =
  | 'allow'
  | 'rescheduled'
  | 'downgraded'
  | 'escalated'
  | 'dropped'
  | 'stopped';

export interface GuardrailOutcome {
  /** Every gate's verdict, in evaluation order. Persisted whole. */
  readonly results: readonly GateVerdict[];
  readonly disposition: ChainDisposition;
  /**
   * The plan as it should now be executed, or null when it must not execute.
   * A reschedule moves `scheduledFor`; a downgrade changes `actionType`.
   */
  readonly plan: GatedPlan | null;
  /** Which gate determined the disposition. null when everything passed. */
  readonly decidedBy: GateName | 'kill_switch' | null;
  /** Human-readable summary of the decision. */
  readonly summary: string;
  /** True when any gate blocked due to missing or malformed input. */
  readonly anyFailedClosed: boolean;
}
