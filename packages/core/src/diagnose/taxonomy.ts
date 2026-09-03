/**
 * The root-cause taxonomy. CLOSED.
 *
 * Transcribed from docs/POLICY_SPEC.md §1. Nothing outside these 21 values is
 * ever a valid cause: the rule table may only return one of them or null, and the
 * LLM may only SELECT from them — never invent. An unmapped case becomes
 * `unknown` and goes to the exception list.
 *
 * This file is the single source of truth. The rule engine, the LLM prompt, the
 * Zod response schema, and the synthetic generator all import from here, so the
 * label sets cannot drift apart. (In Run 2 they had drifted: the generator used
 * its own vocabulary for mandates, checkout, and receivables. See ADR-026.)
 *
 * Pure. No I/O.
 */

/** Payments — full depth (8). */
export const PAYMENT_CAUSES = [
  'issuer_down',
  'issuer_declined',
  'gateway_timeout',
  'insufficient_funds',
  'otp_abandoned',
  'invalid_vpa',
  'expired_card',
  'merchant_config_error',
] as const;
export type PaymentCause = (typeof PAYMENT_CAUSES)[number];

/** Mandates / subscriptions — full depth (4). */
export const MANDATE_CAUSES = [
  'mandate_debit_failed',
  'mandate_insufficient_balance',
  'mandate_revoked',
  'mandate_expired',
] as const;
export type MandateCause = (typeof MANDATE_CAUSES)[number];

/** Checkout abandonment — light depth (3). */
export const CHECKOUT_CAUSES = [
  'abandoned_at_method',
  'abandoned_at_auth',
  'price_hesitation',
] as const;
export type CheckoutCause = (typeof CHECKOUT_CAUSES)[number];

/** Receivables — light depth (3). `overdue_soft` < 15 days, `overdue_hard` ≥ 15. */
export const RECEIVABLE_CAUSES = ['overdue_soft', 'overdue_hard', 'disputed_invoice'] as const;
export type ReceivableCause = (typeof RECEIVABLE_CAUSES)[number];

/** Terminal — all sources (3). */
export const TERMINAL_CAUSES = ['fraud_flag', 'chargeback', 'customer_opt_out'] as const;
export type TerminalCause = (typeof TERMINAL_CAUSES)[number];

/** The day threshold separating a soft from a hard overdue invoice. */
export const OVERDUE_HARD_THRESHOLD_DAYS = 15;

/** Every legal cause. 21 values. */
export const ALL_CAUSES = [
  ...PAYMENT_CAUSES,
  ...MANDATE_CAUSES,
  ...CHECKOUT_CAUSES,
  ...RECEIVABLE_CAUSES,
  ...TERMINAL_CAUSES,
] as const;

export type RootCause = (typeof ALL_CAUSES)[number];

/**
 * `unknown` is NOT a taxonomy member. It is the explicit absence of a diagnosis,
 * and it always routes to the exception list rather than to a plan.
 */
export const UNKNOWN_CAUSE = 'unknown' as const;
export type UnknownCause = typeof UNKNOWN_CAUSE;

/** A diagnosis outcome: a real cause, or an admitted failure to diagnose. */
export type DiagnosedCause = RootCause | UnknownCause;

const CAUSE_SET: ReadonlySet<string> = new Set(ALL_CAUSES);

/** Is this string a legal cause? The gate the LLM's output must pass. */
export function isRootCause(value: unknown): value is RootCause {
  return typeof value === 'string' && CAUSE_SET.has(value);
}

/**
 * Causes that stop everything.
 *
 * Four values, not three: policy.yaml `gates.terminal_check.causes` also lists
 * `mandate_revoked`, and POLICY_SPEC marks it "No — terminal". Where the two
 * documents differ, policy.yaml wins by its own rule, so gate 5 checks four.
 */
export const GATE_TERMINAL_CAUSES = [
  'fraud_flag',
  'chargeback',
  'customer_opt_out',
  'mandate_revoked',
] as const;

const GATE_TERMINAL_SET: ReadonlySet<string> = new Set(GATE_TERMINAL_CAUSES);

/** Does this cause halt the agent? */
export function isTerminalCause(cause: string): boolean {
  return GATE_TERMINAL_SET.has(cause);
}

/** Which source a cause belongs to. Used to reject a cause on the wrong surface. */
export const CAUSES_BY_SOURCE = {
  payment: PAYMENT_CAUSES,
  mandate: MANDATE_CAUSES,
  checkout: CHECKOUT_CAUSES,
  receivable: RECEIVABLE_CAUSES,
} as const;

/**
 * Legal causes for a source: its own set plus the three universal terminal causes.
 * Constrains the LLM prompt so it cannot answer `invalid_vpa` for an invoice.
 */
export function causesForSource(
  source: 'payment' | 'mandate' | 'checkout' | 'receivable',
): readonly string[] {
  return [...CAUSES_BY_SOURCE[source], ...TERMINAL_CAUSES];
}

/** Is `cause` valid for `source`? */
export function isCauseValidForSource(
  cause: string,
  source: 'payment' | 'mandate' | 'checkout' | 'receivable',
): boolean {
  return causesForSource(source).includes(cause);
}
