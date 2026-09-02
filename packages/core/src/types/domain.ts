/**
 * Domain shapes.
 *
 * Deliberately plain data — no methods, no class instances, nothing that has to
 * be hydrated. Rows come out of `@reflow/db` and are handed to core's decision
 * functions as these types. That is what keeps core free of a database import.
 *
 * Run 1 scaffolds these. Runs 3–5 fill in the functions that consume them.
 */

import type { Paise } from '../money.js';
import type {
  ActionStatus,
  ActionType,
  AuditActor,
  CaseSource,
  CaseStatus,
  CauseSource,
  Channel,
  GateName,
  OutcomeResult,
  PaymentMethod,
  PlanStatus,
} from './enums.js';

/** Opaque identifiers. Branding stops a case id being passed where a plan id belongs. */
export type CaseId = string & { readonly __brand: 'CaseId' };
export type PlanId = string & { readonly __brand: 'PlanId' };
export type ActionId = string & { readonly __brand: 'ActionId' };
export type MerchantId = string & { readonly __brand: 'MerchantId' };

/**
 * Ground truth for a synthetic case. Present only when `is_synthetic` is true.
 * The eval harness compares the agent's decisions against this; the live system
 * never reads it.
 */
export interface GroundTruth {
  readonly would_pay_eventually: boolean;
  readonly responds_to: readonly ActionType[];
  readonly best_window_hours: number;
  readonly true_root_cause: string;
}

/** The raw failure signal, before diagnosis. */
export interface FailureSignal {
  readonly error_code: string | null;
  readonly error_source: string | null;
  readonly error_step: string | null;
  readonly error_reason: string | null;
  readonly method: PaymentMethod | null;
  readonly issuer: string | null;
}

/**
 * The central entity: one unit of revenue at risk, whatever its source.
 * Mirrors `recovery_cases`.
 */
export interface RecoveryCase extends FailureSignal {
  readonly id: CaseId;
  readonly merchant_id: MerchantId;
  readonly source: CaseSource;
  readonly external_ref: string | null;
  readonly amount_paise: Paise;
  readonly currency: string;
  /** Opaque. Never a real name, email, or phone. */
  readonly customer_ref: string | null;
  readonly root_cause: string | null;
  readonly cause_confidence: number | null;
  readonly cause_by: CauseSource | null;
  readonly status: CaseStatus;
  readonly attempt_count: number;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly is_synthetic: boolean;
  readonly ground_truth: GroundTruth | null;
}

/** One gate's verdict. Persisted to `plans.guardrail_results` — never discarded. */
export interface GateResult {
  readonly gate: GateName;
  readonly passed: boolean;
  readonly reason: string;
}

/**
 * The agent's intent, before it acts. A decision record, not a queue entry.
 * Mirrors `plans`.
 */
export interface Plan {
  readonly id: PlanId;
  readonly case_id: CaseId;
  readonly action_type: ActionType;
  readonly scheduled_for: Date;
  readonly channel: Channel | null;
  /** DLT template id. Required when `channel` is `sms`. */
  readonly template_id: string | null;
  /** Expected recovery probability, 0..1. */
  readonly expected_p: number;
  readonly est_cost_paise: Paise;
  readonly policy_version: string;
  readonly model_version: string | null;
  readonly guardrail_results: readonly GateResult[];
  readonly status: PlanStatus;
  readonly created_at: Date;
}

/** What actually happened externally. Mirrors `actions`. */
export interface ActionRecord {
  readonly id: ActionId;
  readonly plan_id: PlanId;
  readonly case_id: CaseId;
  readonly executed_at: Date | null;
  /** `executed_at - scheduled_for`. The downtime-honesty metric. */
  readonly lag_seconds: number | null;
  readonly request: unknown;
  readonly response: unknown;
  readonly cost_paise: Paise;
  readonly status: ActionStatus;
  readonly created_at: Date;
}

/** Did it work. Mirrors `outcomes`. `action_id` null = recovered with no action. */
export interface Outcome {
  readonly id: string;
  readonly case_id: CaseId;
  readonly action_id: ActionId | null;
  readonly result: OutcomeResult;
  readonly amount_recovered_paise: Paise;
  readonly observed_at: Date;
}

/** Append-only, hash-chained. Mirrors `audit_log`. */
export interface AuditEntry {
  readonly id: string;
  readonly case_id: CaseId | null;
  readonly actor: AuditActor;
  readonly event_type: string;
  readonly payload: unknown;
  readonly prev_hash: string | null;
  /** `sha256(prev_hash || canonicalJson(payload))`. */
  readonly hash: string;
  readonly at: Date;
}

/** Everything the agent refused to handle. Mirrors `exceptions`. */
export interface ExceptionRecord {
  readonly id: string;
  readonly case_id: CaseId;
  readonly reason: string;
  readonly needs_human: boolean;
  readonly resolved_at: Date | null;
}

/**
 * A domain failure that is an expected outcome rather than a crash.
 *
 * INSTRUCTIONS.md: "domain failures return a result object; exceptions are for
 * genuinely exceptional cases."
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
