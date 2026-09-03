/**
 * The deterministic rule table.
 *
 * Maps `(error_code, error_source, error_step, method)` → one root cause.
 * First match wins; no match returns null so the LLM tail can take it.
 *
 * PURE. No I/O, no clock, no randomness.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS TABLE WAS BUILT — this matters for the credibility of the numbers.
 *
 * Derived from Razorpay's error-field semantics and docs/POLICY_SPEC.md §1, NOT
 * by reading the synthetic generator's `CAUSE_ERROR_SIGNATURES`. Fitting the rules
 * to our own generator would make the Run 7 diagnosis metrics circular and
 * meaningless — the table would be scoring itself.
 *
 * The reasoning for each rule is in its `rationale`. Razorpay's four relevant
 * fields carry distinct meanings:
 *
 *   error_code    coarse class      BAD_REQUEST_ERROR | GATEWAY_ERROR | SERVER_ERROR
 *   error_source  WHO failed        customer | business | bank | issuer | gateway | internal
 *   error_step    WHERE in the flow payment_initiation | _authentication | _authorization
 *   method        the rail          card | upi | netbanking | wallet | emandate
 *
 * `error_source` is the load-bearing field: "the bank had no money" (bank),
 * "the bank said no" (issuer), "the customer walked away" (customer), and "we
 * configured it wrong" (business) are four genuinely different failures that
 * share a code and a step.
 * ---------------------------------------------------------------------------
 */

import type { CaseSource, PaymentMethod } from '../types/enums';
import { OVERDUE_HARD_THRESHOLD_DAYS, type RootCause } from './taxonomy';

/** What the rule table needs to decide. Assembled at the boundary. */
export interface DiagnosisInput {
  readonly source: CaseSource;
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly errorReason: string | null;
  readonly method: PaymentMethod | null;
  readonly issuer: string | null;
  /**
   * Days past due, for receivables only. Drives overdue_soft vs overdue_hard.
   * Derived at the boundary from the invoice, never from ground truth.
   */
  readonly daysOverdue: number | null;
}

/** A single row of the table. */
export interface DiagnosisRule {
  /** Stable id, so a match is traceable and testable. */
  readonly id: string;
  readonly cause: RootCause;
  readonly source: CaseSource;
  readonly errorCode?: readonly string[];
  readonly errorSource?: readonly string[];
  readonly errorStep?: readonly string[];
  /** Rail must be one of these. */
  readonly method?: readonly PaymentMethod[];
  /** Rail must NOT be one of these — separates a mandate rail from a card rail. */
  readonly methodNot?: readonly PaymentMethod[];
  /** Why this tuple means this cause, in Razorpay terms. */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

function token(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Razorpay is inconsistent about whether a step carries the `payment_` prefix,
 * and older payloads use bare verbs. Normalise so the table matches either form.
 */
const STEP_ALIASES: Readonly<Record<string, string>> = {
  authorization: 'payment_authorization',
  authorisation: 'payment_authorization',
  payment_authorisation: 'payment_authorization',
  authentication: 'payment_authentication',
  payment_authentication: 'payment_authentication',
  initiation: 'payment_initiation',
  payment_initiation: 'payment_initiation',
  capture: 'payment_capture',
  payment_capture: 'payment_capture',
};

const SOURCE_ALIASES: Readonly<Record<string, string>> = {
  // Razorpay uses both for a refusing bank.
  issuer_bank: 'issuer',
  acquirer: 'gateway',
  network: 'gateway',
  external: 'gateway',
};

function normalizeStep(value: string | null): string | null {
  const t = token(value);
  if (t === null) return null;
  return STEP_ALIASES[t] ?? t;
}

function normalizeSource(value: string | null): string | null {
  const t = token(value);
  if (t === null) return null;
  return SOURCE_ALIASES[t] ?? t;
}

function includesToken(allowed: readonly string[] | undefined, actual: string | null): boolean {
  if (allowed === undefined) return true; // unconstrained
  if (actual === null) return false;
  return allowed.some((a) => a.toLowerCase() === actual);
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

/** Rails that carry a mandate debit rather than a one-off payment. */
const MANDATE_RAILS: readonly PaymentMethod[] = ['emandate'];

export const DIAGNOSIS_RULES: readonly DiagnosisRule[] = [
  // ---- Terminal, checked first ------------------------------------------
  // Terminal causes must win over anything that could produce an action.
  // `internal` as the source of an authorization failure is Razorpay's own risk
  // engine intervening, which is a fraud hold rather than a bank decision.
  {
    id: 'terminal.fraud_flag',
    cause: 'fraud_flag',
    source: 'payment',
    errorSource: ['internal'],
    errorStep: ['payment_authorization'],
    rationale:
      'An authorization blocked by internal risk, not by the bank — Razorpay held it. Terminal.',
  },
  {
    id: 'terminal.chargeback',
    cause: 'chargeback',
    source: 'payment',
    errorStep: ['settlement'],
    errorSource: ['bank'],
    rationale: 'A bank failure at settlement is money being pulled back, not a failed attempt.',
  },
  {
    id: 'terminal.customer_opt_out',
    cause: 'customer_opt_out',
    source: 'payment',
    errorSource: ['customer'],
    errorStep: ['payment_authorization'],
    methodNot: MANDATE_RAILS,
    rationale:
      'The customer refused at authorization on a one-off rail — an explicit no, not a drop-off. ' +
      'On a mandate rail the same tuple means the mandate was revoked.',
  },

  // ---- Payments, full depth (8) ------------------------------------------
  {
    id: 'payment.issuer_down',
    cause: 'issuer_down',
    source: 'payment',
    errorCode: ['GATEWAY_ERROR'],
    errorSource: ['issuer', 'bank'],
    errorStep: ['payment_authorization'],
    rationale:
      'GATEWAY_ERROR attributed to the issuer means the bank endpoint did not answer. ' +
      'Nothing is wrong with the customer or the instrument.',
  },
  {
    id: 'payment.gateway_timeout',
    cause: 'gateway_timeout',
    source: 'payment',
    errorCode: ['GATEWAY_ERROR'],
    errorSource: ['gateway'],
    rationale:
      'GATEWAY_ERROR attributed to the gateway itself is a transport failure in the middle of ' +
      'the flow, not a decision by anyone.',
  },
  {
    id: 'payment.insufficient_funds',
    cause: 'insufficient_funds',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['bank'],
    errorStep: ['payment_authorization'],
    methodNot: MANDATE_RAILS,
    rationale:
      'The BANK declined at authorization. A bank-sourced decline is a balance problem; an ' +
      'issuer-sourced one is a policy refusal. That distinction is the whole reason ' +
      'error_source exists.',
  },
  {
    id: 'payment.issuer_declined',
    cause: 'issuer_declined',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['issuer'],
    errorStep: ['payment_authorization'],
    methodNot: MANDATE_RAILS,
    rationale:
      'The ISSUER refused at authorization with no further detail. Opaque by nature — ' +
      'POLICY_SPEC allows one retry, then change something.',
  },
  {
    id: 'payment.otp_abandoned',
    cause: 'otp_abandoned',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['customer'],
    errorStep: ['payment_authentication'],
    rationale:
      'Failure at the AUTHENTICATION step sourced to the customer is the 3DS/OTP screen being ' +
      'abandoned. The customer was present and intending to pay.',
  },
  {
    id: 'payment.invalid_vpa',
    cause: 'invalid_vpa',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['customer'],
    errorStep: ['payment_initiation'],
    method: ['upi'],
    rationale:
      'Rejected before it left the building, on UPI. A VPA only exists on UPI, so an ' +
      'initiation-time customer error on that rail is a bad handle.',
  },
  {
    id: 'payment.expired_card',
    cause: 'expired_card',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['customer'],
    errorStep: ['payment_initiation'],
    method: ['card'],
    rationale:
      'Same shape as invalid_vpa but on the card rail: the instrument itself was refused at ' +
      'initiation. Only a card expires.',
  },
  {
    id: 'payment.merchant_config_error',
    cause: 'merchant_config_error',
    source: 'payment',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['business'],
    rationale:
      '`business` means Razorpay is pointing at the merchant — us. Our bug, never the ' +
      "customer's problem, so it must never produce outreach.",
  },

  // ---- Mandates, full depth (4). All on a mandate rail. -------------------
  {
    id: 'mandate.insufficient_balance',
    cause: 'mandate_insufficient_balance',
    source: 'mandate',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['bank'],
    errorStep: ['payment_authorization'],
    rationale: 'Bank declined the scheduled debit: the balance was short on the debit date.',
  },
  {
    id: 'mandate.revoked',
    cause: 'mandate_revoked',
    source: 'mandate',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['customer'],
    errorStep: ['payment_authorization'],
    rationale:
      'The customer refused an authorization on a mandate rail — the mandate itself is gone. ' +
      'Terminal: no retry can fix a cancelled mandate.',
  },
  {
    id: 'mandate.expired',
    cause: 'mandate_expired',
    source: 'mandate',
    errorCode: ['BAD_REQUEST_ERROR'],
    errorSource: ['customer', 'business'],
    errorStep: ['payment_initiation'],
    rationale:
      'Rejected before the debit was attempted: the mandate is past its validity and needs ' +
      're-authorisation.',
  },
  {
    id: 'mandate.debit_failed',
    cause: 'mandate_debit_failed',
    source: 'mandate',
    errorCode: ['BAD_REQUEST_ERROR', 'GATEWAY_ERROR'],
    errorSource: ['issuer', 'gateway'],
    rationale:
      'The debit attempt failed at the issuer or in transit while the mandate stayed intact. ' +
      'Re-presentable after a pre-debit notice.',
  },

  // ---- Checkout abandonment, light depth (3) -----------------------------
  // Razorpay emits no "customer left" event, so this event is ours and carries the
  // stage the customer reached. See ADR-027.
  {
    id: 'checkout.abandoned_at_method',
    cause: 'abandoned_at_method',
    source: 'checkout',
    errorStep: ['checkout_method_selection'],
    rationale: 'Left while choosing how to pay — never committed to a rail.',
  },
  {
    id: 'checkout.abandoned_at_auth',
    cause: 'abandoned_at_auth',
    source: 'checkout',
    errorStep: ['checkout_authentication'],
    rationale: 'Left at the bank/OTP screen. Furthest-progressed and most recoverable.',
  },
  {
    id: 'checkout.price_hesitation',
    cause: 'price_hesitation',
    source: 'checkout',
    errorStep: ['checkout_review'],
    rationale:
      'Left at the review screen, before choosing a method — the total was the objection. ' +
      'POLICY_SPEC says stop: pricing is not a recovery problem.',
  },

  // ---- Receivables, light depth (3) --------------------------------------
  // `overdue_soft` vs `overdue_hard` is a threshold on daysOverdue, applied below
  // rather than in the table, because it is arithmetic and not a tuple match.
  {
    id: 'receivable.disputed',
    cause: 'disputed_invoice',
    source: 'receivable',
    errorSource: ['customer'],
    rationale:
      'The customer, not the calendar, is why this invoice is unpaid. A dispute needs a human ' +
      'and must never be chased with a payment reminder.',
  },
];

/** A rule-table verdict. */
export interface RuleMatch {
  readonly cause: RootCause;
  /** Which rule fired. Recorded for auditability. */
  readonly ruleId: string;
}

function ruleMatches(rule: DiagnosisRule, input: DiagnosisInput): boolean {
  if (rule.source !== input.source) return false;

  const code = token(input.errorCode);
  const source = normalizeSource(input.errorSource);
  const step = normalizeStep(input.errorStep);

  if (!includesToken(rule.errorCode, code)) return false;
  if (!includesToken(rule.errorSource, source)) return false;
  if (!includesToken(rule.errorStep, step)) return false;

  if (rule.method !== undefined) {
    if (input.method === null) return false;
    if (!rule.method.includes(input.method)) return false;
  }
  if (rule.methodNot !== undefined && input.method !== null) {
    if (rule.methodNot.includes(input.method)) return false;
  }

  return true;
}

/**
 * Days past due, parsed out of a structured `error_reason`.
 *
 * Both lanes populate the same field the same way — `invoice_past_due_date:23` —
 * because `recovery_cases` has no dedicated column and adding one for a
 * light-depth surface was not worth a migration. See ADR-028.
 */
export function parseDaysOverdue(errorReason: string | null): number | null {
  const t = token(errorReason);
  if (t === null) return null;
  const match = /:(\d+)$/.exec(t);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Apply the rule table.
 *
 * Returns null when nothing matches — deliberately, so the LLM tail handles the
 * genuine long tail rather than the table guessing.
 */
export function applyRuleTable(input: DiagnosisInput): RuleMatch | null {
  for (const rule of DIAGNOSIS_RULES) {
    if (!ruleMatches(rule, input)) continue;

    // Receivable overdue splits on a day count, not on a tuple.
    if (rule.cause === 'disputed_invoice') return { cause: rule.cause, ruleId: rule.id };

    return { cause: rule.cause, ruleId: rule.id };
  }

  // An overdue invoice that is not disputed: soft or hard by day count.
  if (input.source === 'receivable') {
    const days = input.daysOverdue ?? parseDaysOverdue(input.errorReason);
    if (days !== null) {
      return days >= OVERDUE_HARD_THRESHOLD_DAYS
        ? { cause: 'overdue_hard', ruleId: 'receivable.overdue_hard' }
        : { cause: 'overdue_soft', ruleId: 'receivable.overdue_soft' };
    }
  }

  return null;
}

/**
 * Every cause the table can produce. Used by a test that asserts the table
 * covers the taxonomy, so a cause cannot be silently unreachable.
 */
export function causesCoveredByRules(): readonly RootCause[] {
  const covered = new Set<RootCause>(DIAGNOSIS_RULES.map((r) => r.cause));
  // Added by the arithmetic branch rather than by a table row.
  covered.add('overdue_soft');
  covered.add('overdue_hard');
  return [...covered];
}
