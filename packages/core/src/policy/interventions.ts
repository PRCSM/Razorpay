/**
 * The cause → intervention map, from docs/POLICY_SPEC.md §3.
 *
 * Every one of the 21 taxonomy causes maps to something. Terminal causes map to
 * `stop`. Nothing falls through — `INTERVENTIONS` is typed as a total record over
 * `RootCause`, so omitting a cause is a COMPILE ERROR rather than a runtime
 * surprise, and a test asserts the same at runtime.
 *
 * Costs are never hardcoded here. Each intervention declares which policy.yaml
 * cost applies and `estimateCostPaise` reads it, so changing a rate in the YAML
 * changes every estimate.
 *
 * PURE.
 */

import type { ActionType, Channel } from '../types/enums';
import type { RootCause } from '../diagnose/taxonomy';
import type { PolicyCosts } from './schema';

/**
 * Which policy.yaml cost line an action draws from.
 * `none` means genuinely free — a retry costs nothing to attempt.
 */
export type CostBasis =
  | 'sms_paise'
  | 'whatsapp_paise'
  | 'human_escalation_paise'
  | 'retry_paise'
  | 'payment_link_paise'
  | 'none';

/** One step of an intervention ladder. */
export interface Intervention {
  readonly actionType: ActionType;
  readonly channel: Channel;
  readonly costBasis: CostBasis;
  /**
   * Expected recovery probability, 0..1.
   *
   * These are ASSUMPTIONS, and docs/EVAL_METHODOLOGY.md threat 5 says so: "Response
   * probabilities are assumptions, not observations." They drive `expected_p` and
   * the cost-per-rupee estimate, and they are here in one table so they can be
   * argued with in one place. The eval measures actual outcomes against ground
   * truth and does not take these as given.
   */
  readonly expectedP: number;
  /** True when this step reaches a human being — the contact gates apply. */
  readonly isContact: boolean;
}

export interface InterventionPlan {
  /**
   * The ladder for this cause, indexed by attempt. POLICY_SPEC describes several
   * causes as sequences: "delayed_retry @ 24h ×1, then method_switch".
   */
  readonly ladder: readonly Intervention[];
  /** Max attempts this cause justifies, capped again by gate 1. */
  readonly maxAttempts: number;
  /** Why this is the right response. Surfaced in the dashboard and the audit log. */
  readonly rationale: string;
}

const retry = (expectedP: number, actionType: ActionType = 'delayed_retry'): Intervention => ({
  actionType,
  channel: 'none',
  costBasis: 'retry_paise',
  expectedP,
  isContact: false,
});

const link = (expectedP: number): Intervention => ({
  actionType: 'payment_link',
  channel: 'none',
  costBasis: 'payment_link_paise',
  expectedP,
  isContact: false,
});

const methodSwitch = (expectedP: number): Intervention => ({
  actionType: 'method_switch',
  channel: 'none',
  costBasis: 'none',
  expectedP,
  isContact: false,
});

const nudge = (expectedP: number, channel: Channel = 'sms'): Intervention => ({
  actionType: 'nudge',
  channel,
  costBasis: channel === 'whatsapp' ? 'whatsapp_paise' : 'sms_paise',
  expectedP,
  isContact: true,
});

const preDebitNotice = (expectedP: number): Intervention => ({
  actionType: 'pre_debit_notice',
  channel: 'sms',
  costBasis: 'sms_paise',
  expectedP,
  isContact: true,
});

const promiseToPay = (expectedP: number): Intervention => ({
  actionType: 'promise_to_pay',
  channel: 'whatsapp',
  costBasis: 'whatsapp_paise',
  expectedP,
  isContact: true,
});

const escalate = (expectedP: number): Intervention => ({
  actionType: 'escalate_human',
  channel: 'none',
  costBasis: 'human_escalation_paise',
  expectedP,
  isContact: false,
});

/**
 * Terminal and non-recoverable causes.
 *
 * `maxAttempts` is 1, not 0. `stop` is itself a decision that must be RECORDED —
 * TASK 1 requires every cause to map to something, and a terminal case needs a
 * persisted plan saying "we deliberately did nothing, here is why" rather than no
 * row at all. A second call returns null, because one stop is enough.
 */
const STOP: InterventionPlan = {
  ladder: [
    {
      actionType: 'stop',
      channel: 'none',
      costBasis: 'none',
      expectedP: 0,
      isContact: false,
    },
  ],
  maxAttempts: 1,
  rationale: 'Terminal or non-recoverable: the agent stops. No retry, no message.',
};

/**
 * The map. Total over `RootCause` — omitting a cause will not compile.
 */
export const INTERVENTIONS: Readonly<Record<RootCause, InterventionPlan>> = {
  // ---- Payments (POLICY_SPEC §3, payments table) --------------------------
  issuer_down: {
    ladder: [retry(0.62), retry(0.5), retry(0.35)],
    maxAttempts: 3,
    rationale:
      "Downtime is usually short and it isn't the customer's fault, so retry silently and " +
      'never message. Timed to the outage end when Razorpay reported one.',
  },
  issuer_declined: {
    ladder: [retry(0.18), methodSwitch(0.26)],
    maxAttempts: 2,
    rationale:
      'An opaque refusal. POLICY_SPEC allows exactly one retry, then change something rather ' +
      'than asking the same bank the same question again.',
  },
  gateway_timeout: {
    ladder: [retry(0.55, 'immediate_retry'), retry(0.45), retry(0.3)],
    maxAttempts: 3,
    rationale: 'Often transient and free to attempt. The cheapest possible fix, tried first.',
  },
  insufficient_funds: {
    ladder: [retry(0.42), nudge(0.34), retry(0.24)],
    maxAttempts: 3,
    rationale:
      'Timing is everything: the balance arrives with the salary cycle. Retry into the salary ' +
      'window, and only then ask.',
  },
  otp_abandoned: {
    ladder: [retry(0.4, 'immediate_retry'), methodSwitch(0.36), nudge(0.24)],
    maxAttempts: 3,
    rationale:
      'The customer was present and intending to pay — the highest-value recovery there is. ' +
      'Re-present immediately, then offer an easier rail.',
  },
  invalid_vpa: {
    ladder: [link(0.3), nudge(0.2)],
    maxAttempts: 2,
    rationale:
      'Retrying the same handle cannot work. A link with alternate methods is the only thing ' +
      'that can.',
  },
  expired_card: {
    ladder: [link(0.28), nudge(0.22)],
    maxAttempts: 2,
    rationale: 'Needs a new instrument, so no retry can help. Link first, then one ask.',
  },
  merchant_config_error: {
    ladder: [escalate(0.8)],
    maxAttempts: 1,
    rationale:
      'Our own misconfiguration. A human fixes it, and the customer is never contacted about ' +
      'our bug.',
  },

  // ---- Mandates ----------------------------------------------------------
  // Gate 7 enforces notice-before-re-presentment; the ladder puts it first.
  mandate_debit_failed: {
    ladder: [preDebitNotice(0.3), retry(0.5)],
    maxAttempts: 2,
    rationale:
      'The mandate is intact, so it can be re-presented — but regulation requires prior notice, ' +
      'so the notice comes first and gate 7 enforces the ordering.',
  },
  mandate_insufficient_balance: {
    ladder: [preDebitNotice(0.28), retry(0.44)],
    maxAttempts: 2,
    rationale: 'Same as a failed debit, timed to the salary window instead of a flat 48h.',
  },
  mandate_revoked: STOP,
  mandate_expired: {
    ladder: [nudge(0.22)],
    maxAttempts: 1,
    rationale:
      'Past validity and only the customer can re-authorise. One ask, then stop — POLICY_SPEC ' +
      'is explicit that this is a single nudge.',
  },

  // ---- Checkout (light depth) --------------------------------------------
  abandoned_at_method: {
    ladder: [link(0.24), nudge(0.16)],
    maxAttempts: 2,
    rationale: 'Never committed to a rail. A link removes the choice that stalled them.',
  },
  abandoned_at_auth: {
    ladder: [nudge(0.3), link(0.26)],
    maxAttempts: 2,
    rationale:
      'Furthest through the funnel and the warmest intent of the three, so a prompt nudge is ' +
      'worth its cost here.',
  },
  price_hesitation: STOP,

  // ---- Receivables (light depth) -----------------------------------------
  overdue_soft: {
    ladder: [nudge(0.4), link(0.3)],
    maxAttempts: 2,
    rationale: 'Recently due. A reminder is usually enough, and a link makes paying trivial.',
  },
  overdue_hard: {
    ladder: [promiseToPay(0.3), escalate(0.24)],
    maxAttempts: 2,
    rationale:
      'Old debt. Capture a commitment date, then hand it to a person — automated reminders stop ' +
      'working at this age.',
  },
  disputed_invoice: {
    ladder: [escalate(0.26)],
    maxAttempts: 1,
    rationale:
      'A dispute is a conversation, not a collection. Escalate immediately and never send a ' +
      'payment reminder.',
  },

  // ---- Terminal, all surfaces --------------------------------------------
  fraud_flag: STOP,
  chargeback: STOP,
  customer_opt_out: STOP,
};

/** The intervention for this attempt, or null when the ladder is exhausted. */
export function interventionForAttempt(
  cause: RootCause,
  attemptCount: number,
): Intervention | null {
  const plan = INTERVENTIONS[cause];
  const index = Number.isInteger(attemptCount) && attemptCount > 0 ? attemptCount : 0;

  if (index >= plan.maxAttempts) return null;
  return plan.ladder[Math.min(index, plan.ladder.length - 1)] ?? null;
}

/**
 * The cost of an intervention, read from policy.yaml.
 *
 * Never hardcoded (TASK 1). A missing or malformed cost yields the
 * `human_escalation_paise` figure rather than 0 — failing closed on money means
 * assuming an action is EXPENSIVE, so a broken cost model cannot make a wasteful
 * plan look free to the cost-per-rupee metric.
 */
export function estimateCostPaise(intervention: Intervention, costs: PolicyCosts): number {
  if (intervention.costBasis === 'none') return 0;

  const value = costs[intervention.costBasis];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    const fallback = costs.human_escalation_paise;
    return typeof fallback === 'number' && Number.isInteger(fallback) && fallback >= 0
      ? fallback
      : 0;
  }
  return value;
}

/** Does this action reach a human? The contact gates key off this. */
export function isContactAction(actionType: ActionType): boolean {
  return actionType === 'nudge' || actionType === 'pre_debit_notice' || actionType === 'promise_to_pay';
}
