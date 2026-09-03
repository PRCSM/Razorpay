/**
 * The generator's distribution, transcribed from docs/EVAL_METHODOLOGY.md.
 *
 * Kept as DATA rather than inlined into the generator so the tests assert against
 * the same table the generator draws from, and so a judge can diff this file
 * against the methodology document line by line.
 *
 * docs/EVAL_METHODOLOGY.md, threat 1: the distribution was fixed BEFORE the
 * policy engine was implemented, not tuned afterwards to flatter it.
 */

import type { ActionType, CaseSource, PaymentMethod } from '@reflow/core';
import type { Weighted } from './prng';

/** Source mix: 55 / 20 / 15 / 10. */
export const SOURCE_MIX: readonly Weighted<CaseSource>[] = [
  { value: 'payment', weight: 55 },
  { value: 'mandate', weight: 20 },
  { value: 'checkout', weight: 15 },
  { value: 'receivable', weight: 10 },
];

/** Terminal cases injected at 12% across all sources. */
export const TERMINAL_SHARE = 0.12;

/** Root causes within payments. Shares sum to 100. */
export const PAYMENT_CAUSE_MIX: readonly Weighted<string>[] = [
  { value: 'insufficient_funds', weight: 24 },
  { value: 'otp_abandoned', weight: 20 },
  { value: 'issuer_down', weight: 16 },
  { value: 'gateway_timeout', weight: 12 },
  { value: 'issuer_declined', weight: 12 },
  { value: 'invalid_vpa', weight: 6 },
  { value: 'expired_card', weight: 6 },
  { value: 'merchant_config_error', weight: 4 },
];

/**
 * Non-terminal mandate causes, from the POLICY_SPEC taxonomy (4 total;
 * `mandate_revoked` arrives via terminal injection).
 *
 * Corrected in Run 3. Run 2 emitted `mandate_pre_debit_missing`, `mandate_paused`,
 * and bare `insufficient_funds` here — none of which are legal mandate causes.
 * See ADR-026.
 */
export const MANDATE_CAUSE_MIX: readonly Weighted<string>[] = [
  { value: 'mandate_insufficient_balance', weight: 48 },
  { value: 'mandate_debit_failed', weight: 32 },
  { value: 'mandate_expired', weight: 20 },
];

/** Non-terminal checkout causes. Behavioural — the stage the customer left at. */
export const CHECKOUT_CAUSE_MIX: readonly Weighted<string>[] = [
  { value: 'abandoned_at_method', weight: 40 },
  { value: 'abandoned_at_auth', weight: 34 },
  { value: 'price_hesitation', weight: 26 },
];

/**
 * Non-terminal receivable causes.
 *
 * `overdue_soft` (<15 days) and `overdue_hard` (≥15 days) are the same provider
 * signal split by a day count, so the generator draws a `daysOverdue` and the
 * cause follows from it rather than being chosen directly. Only `disputed_invoice`
 * is an independent draw.
 */
export const RECEIVABLE_CAUSE_MIX: readonly Weighted<string>[] = [
  { value: 'overdue_soft', weight: 44 },
  { value: 'overdue_hard', weight: 34 },
  { value: 'disputed_invoice', weight: 22 },
];

/** Days-overdue ranges that produce each overdue cause. Threshold is 15 days. */
export const OVERDUE_SOFT_DAYS: readonly [number, number] = [1, 14];
export const OVERDUE_HARD_DAYS: readonly [number, number] = [15, 95];
/** A disputed invoice still has an age; it just is not what drives the cause. */
export const DISPUTED_DAYS: readonly [number, number] = [2, 60];

/**
 * Terminal causes, from policy.yaml `gates.terminal_check.causes`.
 * `mandate_revoked` only applies to mandates; the rest apply anywhere.
 */
export const TERMINAL_CAUSES_GENERAL = ['fraud_flag', 'chargeback', 'customer_opt_out'] as const;
export const TERMINAL_CAUSE_MANDATE = 'mandate_revoked' as const;

/** Issuers are labels with distributions, not models of real banks (methodology). */
export const ISSUERS: readonly string[] = [
  'hdfc',
  'icici',
  'sbi',
  'axis',
  'kotak',
  'idfc',
  'yesbank',
  'paytm',
];

/** Methods that plausibly carry each cause. */
export const CAUSE_METHOD_MIX: Readonly<Record<string, readonly Weighted<PaymentMethod>[]>> = {
  insufficient_funds: [
    { value: 'card', weight: 45 },
    { value: 'upi', weight: 40 },
    { value: 'netbanking', weight: 15 },
  ],
  otp_abandoned: [
    { value: 'card', weight: 60 },
    { value: 'netbanking', weight: 25 },
    { value: 'upi', weight: 15 },
  ],
  issuer_down: [
    { value: 'upi', weight: 45 },
    { value: 'card', weight: 35 },
    { value: 'netbanking', weight: 20 },
  ],
  gateway_timeout: [
    { value: 'card', weight: 40 },
    { value: 'upi', weight: 35 },
    { value: 'netbanking', weight: 15 },
    { value: 'wallet', weight: 10 },
  ],
  issuer_declined: [
    { value: 'card', weight: 70 },
    { value: 'netbanking', weight: 20 },
    { value: 'upi', weight: 10 },
  ],
  // A VPA only exists on UPI.
  invalid_vpa: [{ value: 'upi', weight: 100 }],
  // Only a card expires.
  expired_card: [{ value: 'card', weight: 100 }],
  merchant_config_error: [
    { value: 'card', weight: 50 },
    { value: 'upi', weight: 30 },
    { value: 'netbanking', weight: 20 },
  ],
};

/**
 * The provider error tuple each cause presents as.
 *
 * This is what Run 3's deterministic rule table matches on —
 * `(error_code, error_source, error_step, method)` → root cause — so these tuples
 * must be plausible Razorpay values, not invented ones, or the rule table trains
 * against fiction.
 */
export interface ErrorSignature {
  readonly errorCode: string;
  readonly errorSource: string;
  readonly errorStep: string;
  readonly errorReason: string;
}

export const CAUSE_ERROR_SIGNATURES: Readonly<Record<string, ErrorSignature>> = {
  insufficient_funds: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'bank',
    errorStep: 'payment_authorization',
    errorReason: 'insufficient_funds',
  },
  otp_abandoned: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_authentication',
    errorReason: 'payment_cancelled_by_user',
  },
  issuer_down: {
    errorCode: 'GATEWAY_ERROR',
    errorSource: 'issuer',
    errorStep: 'payment_authorization',
    errorReason: 'issuer_unavailable',
  },
  gateway_timeout: {
    errorCode: 'GATEWAY_ERROR',
    errorSource: 'gateway',
    errorStep: 'payment_authorization',
    errorReason: 'gateway_timeout',
  },
  issuer_declined: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'issuer',
    errorStep: 'payment_authorization',
    errorReason: 'payment_declined_by_issuer',
  },
  invalid_vpa: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_initiation',
    errorReason: 'invalid_vpa',
  },
  expired_card: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_initiation',
    errorReason: 'card_expired',
  },
  merchant_config_error: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'business',
    errorStep: 'payment_initiation',
    errorReason: 'merchant_config_invalid',
  },
  // ---- mandates. All on the emandate rail. --------------------------------
  mandate_insufficient_balance: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'bank',
    errorStep: 'payment_authorization',
    errorReason: 'insufficient_funds',
  },
  mandate_debit_failed: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'issuer',
    errorStep: 'payment_authorization',
    errorReason: 'debit_attempt_failed',
  },
  mandate_expired: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_initiation',
    errorReason: 'mandate_expired',
  },
  mandate_revoked: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_authorization',
    errorReason: 'mandate_revoked',
  },
  fraud_flag: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'internal',
    errorStep: 'payment_authorization',
    errorReason: 'fraud_suspected',
  },
  chargeback: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'bank',
    errorStep: 'settlement',
    errorReason: 'chargeback_raised',
  },
  customer_opt_out: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorSource: 'customer',
    errorStep: 'payment_authorization',
    errorReason: 'customer_opted_out',
  },
  // ---- checkout. Our own simulated event, carrying the stage reached. ------
  abandoned_at_method: {
    errorCode: 'CHECKOUT_ABANDONED',
    errorSource: 'customer',
    errorStep: 'checkout_method_selection',
    errorReason: 'left_before_choosing_method',
  },
  abandoned_at_auth: {
    errorCode: 'CHECKOUT_ABANDONED',
    errorSource: 'customer',
    errorStep: 'checkout_authentication',
    errorReason: 'left_at_bank_authentication',
  },
  price_hesitation: {
    errorCode: 'CHECKOUT_ABANDONED',
    errorSource: 'customer',
    errorStep: 'checkout_review',
    errorReason: 'left_at_order_review',
  },

  // ---- receivables. `error_source` separates a dispute from mere age; the
  // day count in error_reason splits soft from hard. See ADR-028.
  overdue_soft: {
    errorCode: 'INVOICE_EXPIRED',
    errorSource: 'business',
    errorStep: 'invoice_settlement',
    errorReason: 'invoice_past_due_date',
  },
  overdue_hard: {
    errorCode: 'INVOICE_EXPIRED',
    errorSource: 'business',
    errorStep: 'invoice_settlement',
    errorReason: 'invoice_past_due_date',
  },
  disputed_invoice: {
    errorCode: 'INVOICE_EXPIRED',
    errorSource: 'customer',
    errorStep: 'invoice_settlement',
    errorReason: 'invoice_disputed_by_customer',
  },
};

/**
 * Ground truth per cause.
 *
 * These are ASSUMPTIONS, and methodology threat 5 says so plainly: "Response
 * probabilities are assumptions, not observations. If those beliefs are wrong,
 * Arm C's advantage is overstated." They are here in one table so they can be
 * challenged in one place.
 */
export interface CauseGroundTruth {
  /** Probability the customer would have paid with no intervention at all. */
  readonly wouldPayEventually: number;
  /** Interventions that work. An action not on this list fails. */
  readonly respondsTo: readonly ActionType[];
  /** Optimal delay. Actions within ±30% succeed at full rate. */
  readonly bestWindowHours: readonly [number, number];
}

export const CAUSE_GROUND_TRUTH: Readonly<Record<string, CauseGroundTruth>> = {
  // Money arrives with the salary cycle; waiting is what works.
  insufficient_funds: {
    wouldPayEventually: 0.72,
    respondsTo: ['delayed_retry', 'payment_link', 'nudge'],
    bestWindowHours: [18, 48],
  },
  // The customer was present and hesitated. Re-engage quickly.
  otp_abandoned: {
    wouldPayEventually: 0.5,
    respondsTo: ['payment_link', 'nudge', 'immediate_retry'],
    bestWindowHours: [1, 4],
  },
  // Nothing was wrong with the customer. Wait for the outage to clear.
  issuer_down: {
    wouldPayEventually: 0.82,
    respondsTo: ['delayed_retry', 'immediate_retry', 'method_switch'],
    bestWindowHours: [2, 6],
  },
  gateway_timeout: {
    wouldPayEventually: 0.85,
    respondsTo: ['immediate_retry', 'delayed_retry'],
    bestWindowHours: [1, 3],
  },
  // The issuer said no and will say no again. Change something.
  issuer_declined: {
    wouldPayEventually: 0.34,
    respondsTo: ['method_switch', 'payment_link'],
    bestWindowHours: [4, 12],
  },
  invalid_vpa: {
    wouldPayEventually: 0.42,
    respondsTo: ['method_switch', 'nudge', 'payment_link'],
    bestWindowHours: [2, 8],
  },
  expired_card: {
    wouldPayEventually: 0.38,
    respondsTo: ['method_switch', 'nudge', 'payment_link'],
    bestWindowHours: [6, 24],
  },
  // Our fault, not theirs. A human must fix the config; the customer will pay.
  merchant_config_error: {
    wouldPayEventually: 0.88,
    respondsTo: ['escalate_human', 'immediate_retry'],
    bestWindowHours: [1, 2],
  },
  // ---- mandates. POLICY_SPEC §3 requires a pre-debit notice before any
  // re-presentment, so `pre_debit_notice` leads for every recoverable mandate.
  mandate_insufficient_balance: {
    wouldPayEventually: 0.68,
    respondsTo: ['pre_debit_notice', 'delayed_retry'],
    bestWindowHours: [24, 72],
  },
  mandate_debit_failed: {
    wouldPayEventually: 0.74,
    respondsTo: ['pre_debit_notice', 'delayed_retry', 'immediate_retry'],
    bestWindowHours: [24, 48],
  },
  // Needs re-authorisation, which only the customer can give. One ask, then stop.
  mandate_expired: {
    wouldPayEventually: 0.26,
    respondsTo: ['nudge', 'payment_link'],
    bestWindowHours: [12, 48],
  },

  // ---- checkout. Deeper in the funnel means warmer intent.
  abandoned_at_method: {
    wouldPayEventually: 0.3,
    respondsTo: ['payment_link', 'nudge'],
    bestWindowHours: [1, 4],
  },
  // Furthest progressed: they were at the bank screen. Most recoverable.
  abandoned_at_auth: {
    wouldPayEventually: 0.44,
    respondsTo: ['payment_link', 'nudge', 'method_switch'],
    bestWindowHours: [1, 3],
  },
  // POLICY_SPEC says stop — pricing is not a recovery problem. Nothing we send
  // changes the price, so the responds_to list is deliberately thin.
  price_hesitation: {
    wouldPayEventually: 0.18,
    respondsTo: ['nudge'],
    bestWindowHours: [4, 12],
  },

  // ---- receivables.
  overdue_soft: {
    wouldPayEventually: 0.7,
    respondsTo: ['nudge', 'payment_link', 'promise_to_pay'],
    bestWindowHours: [24, 72],
  },
  // Older debt is harder debt.
  overdue_hard: {
    wouldPayEventually: 0.44,
    respondsTo: ['promise_to_pay', 'escalate_human'],
    bestWindowHours: [48, 120],
  },
  disputed_invoice: {
    wouldPayEventually: 0.28,
    respondsTo: ['escalate_human', 'promise_to_pay'],
    bestWindowHours: [24, 96],
  },
};

/**
 * Terminal ground truth. `responds_to` is EMPTY and `would_pay_eventually` is
 * false: nothing works, so any action on a terminal case is pure waste. The eval
 * counts those as "wasted terminal attempts", which must be 0 for Arm C.
 */
export const TERMINAL_GROUND_TRUTH: CauseGroundTruth = {
  wouldPayEventually: 0,
  respondsTo: [],
  bestWindowHours: [0, 0],
};

/** Amount ranges in PAISE per source. Integer paise everywhere, never rupees. */
export const AMOUNT_RANGES_PAISE: Readonly<Record<CaseSource, readonly [number, number]>> = {
  // ₹150 – ₹18,000
  payment: [15_000, 1_800_000],
  // ₹199 – ₹4,999 — subscriptions cluster low
  mandate: [19_900, 499_900],
  // ₹400 – ₹25,000
  checkout: [40_000, 2_500_000],
  // ₹3,000 – ₹2,50,000 — B2B invoices are large and cross the ₹25,000
  // autonomous ceiling, which is what exercises guardrail gate 6.
  receivable: [300_000, 25_000_000],
};

/** issuer_down arrives in clusters of 8–20 inside a 30-minute window. */
export const BURST_MIN_SIZE = 8;
export const BURST_MAX_SIZE = 20;
export const BURST_WINDOW_MINUTES = 30;

/** insufficient_funds clusters in the 18th–28th of the month. */
export const SALARY_SQUEEZE_DAY_MIN = 18;
export const SALARY_SQUEEZE_DAY_MAX = 28;

/**
 * Share of insufficient_funds cases that land inside the salary window.
 *
 * Deliberately NOT 1.0. The methodology says these cases "cluster" in the
 * 18th–28th, not that they only ever happen then — real balances run low all
 * month. Forcing 100% would make the salary-cycle timing heuristic trivially
 * perfect and would overstate Arm C's advantage, which is precisely threat 3
 * in docs/EVAL_METHODOLOGY.md ("the salary-cycle heuristic is unvalidated").
 *
 * The window is 11 of ~30 days, so ~37% of the month. Concentrating 70% of cases
 * there is a strong, visible cluster that still leaves a real tail to get wrong.
 */
export const SALARY_SQUEEZE_CONCENTRATION = 0.7;

/** How far back cases are spread. */
export const SIMULATION_WINDOW_DAYS = 60;
