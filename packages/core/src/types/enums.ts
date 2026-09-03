/**
 * The closed vocabularies of the domain.
 *
 * These are the single source of truth for every `text` column in
 * docs/DATABASE_DESIGN.md that carries a constrained set of values. The Drizzle
 * schema imports these arrays so the database and the domain can never drift
 * apart, and Zod builds enums from the same arrays.
 *
 * No business logic here — vocabulary only.
 */

/** Where a unit of revenue at risk came from. Four surfaces, one engine. */
export const CASE_SOURCES = ['payment', 'mandate', 'checkout', 'receivable'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

/** Full-depth surfaces get the complete policy chain; light-depth get a subset. */
export const FULL_DEPTH_SOURCES = ['payment', 'mandate'] as const;
export const LIGHT_DEPTH_SOURCES = ['checkout', 'receivable'] as const;

export const PAYMENT_METHODS = ['card', 'upi', 'netbanking', 'wallet', 'emandate'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Lifecycle of a recovery case.
 * open → diagnosed → planned → acting → (recovered | stopped | exception)
 */
export const CASE_STATUSES = [
  'open',
  'diagnosed',
  'planned',
  'acting',
  'recovered',
  'stopped',
  'exception',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Terminal statuses close a case; `closed_at` is set when one is reached. */
export const TERMINAL_CASE_STATUSES = ['recovered', 'stopped', 'exception'] as const;
export type TerminalCaseStatus = (typeof TERMINAL_CASE_STATUSES)[number];

/**
 * What decided the root cause. Makes the LLM's role auditable.
 *
 * `downtime_signal` was added in Run 3: Razorpay reports issuer downtime directly
 * via `payment.downtime.*`, so a failure inside a confirmed outage window is an
 * OBSERVED fact rather than an inference from an error code. Keeping it distinct
 * from `rule` means RESULTS.md can show how much of `issuer_down` was measured
 * versus deduced. See ADR-029.
 */
export const CAUSE_SOURCES = ['rule', 'llm', 'downtime_signal'] as const;
export type CauseSource = (typeof CAUSE_SOURCES)[number];

/**
 * Every intervention the agent can choose, plus `stop`.
 * Matches the `plans.action_type` vocabulary in DATABASE_DESIGN.md.
 */
export const ACTION_TYPES = [
  'immediate_retry',
  'delayed_retry',
  'method_switch',
  'payment_link',
  'nudge',
  'pre_debit_notice',
  'promise_to_pay',
  'escalate_human',
  'stop',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Actions that reach a human being. Quiet hours and the contact cap apply to
 * these; silent actions (retries, link generation) stay allowed overnight.
 */
export const CONTACT_ACTION_TYPES = [
  'nudge',
  'pre_debit_notice',
  'promise_to_pay',
] as const;
export type ContactActionType = (typeof CONTACT_ACTION_TYPES)[number];

export const CHANNELS = ['sms', 'whatsapp', 'email', 'none'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PLAN_STATUSES = ['pending', 'executed', 'dropped', 'downgraded'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** `skipped_on_regate` records a plan dropped at execution because state changed. */
export const ACTION_STATUSES = ['success', 'failed', 'skipped_on_regate'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const OUTCOME_RESULTS = ['recovered', 'no_response', 'opted_out', 'failed'] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const AUDIT_ACTORS = ['system', 'llm', 'human', 'scheduler'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

/**
 * The ordered guardrail chain from policy.yaml. Order is load-bearing:
 * `terminal_check` must be evaluated before any gate that could produce
 * contact, so a fraud-flagged or opted-out customer is never messaged.
 */
export const GATE_NAMES = [
  'injection_screen',
  'attempt_cap',
  'cooling_window',
  'contact_cap',
  'quiet_hours',
  'terminal_check',
  'amount_ceiling',
  'compliance',
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** Causes that stop everything, from policy.yaml `terminal_check.causes`. */
export const TERMINAL_ROOT_CAUSES = [
  'fraud_flag',
  'chargeback',
  'customer_opt_out',
  'mandate_revoked',
] as const;
export type TerminalRootCause = (typeof TERMINAL_ROOT_CAUSES)[number];

export const TIMING_STRATEGIES = ['static', 'bandit'] as const;
export type TimingStrategy = (typeof TIMING_STRATEGIES)[number];
