/**
 * `StaticTimingStrategy` — the default, and the baseline the bandit is measured
 * against.
 *
 * The delay table is docs/POLICY_SPEC.md §4, transcribed. Three behaviours sit on
 * top of it, in precedence order:
 *
 *   1. **Downtime-aware** (TASK 3). If Razorpay told us the issuer was down, the
 *      retry is timed to the outage's actual end rather than to a guessed +2h.
 *      While the outage is still open, a re-check is scheduled instead of an
 *      action — retrying into a bank that is still down burns an attempt against
 *      the cap for nothing.
 *   2. **Salary cycle**. A late-month `insufficient_funds` failure schedules to
 *      the next 1st–3rd rather than +24h.
 *   3. **The table**, with a per-attempt escalation for causes POLICY_SPEC
 *      describes as a sequence ("immediate_retry, then delayed_retry @ 1h").
 *
 * PURE. Every delay goes through `scaleDelayMs`.
 */

import { DAY_MS, HOUR_MS, hoursToMs, istClock, scheduleAfter } from './clock';
import { nextSalaryWindow } from './clock';
import type { TimingContext, TimingDecision, TimingStrategy } from './strategy';

/**
 * Delay per attempt, in hours, from POLICY_SPEC §4.
 *
 * A list models the escalating sequences the spec describes: `gateway_timeout` is
 * "0, then 1h", `otp_abandoned` is "0, then 4h". The last entry repeats if there
 * are more attempts than entries — the attempt cap stops the case long before
 * that matters.
 */
export const STATIC_DELAY_HOURS: Readonly<Record<string, readonly number[]>> = {
  // "Downtime is usually short." 2h, up to 3 attempts.
  issuer_down: [2, 2, 4],
  // "Opaque. One retry, then change something."
  issuer_declined: [24, 24],
  // "Often transient. Cheapest possible fix."
  gateway_timeout: [0, 1, 2],
  // Overridden by the salary-cycle heuristic when a window is available.
  insufficient_funds: [24, 24, 48],
  // "Customer was present and intending to pay." Strike while intent is warm.
  otp_abandoned: [0, 4, 12],
  // Retrying the same handle cannot work, so this is about when to ask again.
  invalid_vpa: [1, 6],
  // Needs a new instrument; no point rushing.
  expired_card: [2, 24],
  // Our bug. Escalate now — a human has to fix it.
  merchant_config_error: [0],

  // Mandates: 48h is the re-presentment convention (POLICY_SPEC §4).
  mandate_debit_failed: [48, 48],
  mandate_insufficient_balance: [48, 72],
  // Terminal, but a delay is still returned so the shape is uniform.
  mandate_revoked: [0],
  mandate_expired: [4, 24],

  // Checkout: intent decays fast.
  abandoned_at_method: [1, 6],
  abandoned_at_auth: [0.5, 4],
  price_hesitation: [0],

  // Receivables move on business days, not hours.
  overdue_soft: [72, 120],
  overdue_hard: [24, 72],
  disputed_invoice: [0],

  // Terminal causes: no delay is meaningful, the plan is `stop`.
  fraud_flag: [0],
  chargeback: [0],
  customer_opt_out: [0],
};

/** Hour of the IST day a salary-window action is aimed at. Mid-morning, post-credit. */
const SALARY_WINDOW_HOUR = 11;

/** How long to wait before re-checking an outage that has not resolved. */
const DOWNTIME_RECHECK_HOURS = 1;

/** Grace period after an outage resolves, so the issuer has settled. */
const DOWNTIME_RECOVERY_GRACE_HOURS = 0.5;

/** Fallback when a cause has no table entry — should be unreachable. */
const DEFAULT_DELAY_HOURS = 6;

/** The delay for this attempt, clamped to the table's last entry. */
export function staticDelayHours(rootCause: string, attemptCount: number): number {
  const ladder = STATIC_DELAY_HOURS[rootCause];
  if (!ladder || ladder.length === 0) return DEFAULT_DELAY_HOURS;

  const index = Number.isInteger(attemptCount) && attemptCount > 0 ? attemptCount : 0;
  const clamped = Math.min(index, ladder.length - 1);
  return ladder[clamped] ?? DEFAULT_DELAY_HOURS;
}

export class StaticTimingStrategy implements TimingStrategy {
  public readonly name = 'static' as const;

  schedule(context: TimingContext, now: Date): TimingDecision {
    const downtime = this.scheduleFromDowntime(context, now);
    if (downtime) return downtime;

    const salary = this.scheduleFromSalaryWindow(context, now);
    if (salary) return salary;

    const hours = staticDelayHours(context.rootCause, context.attemptCount);
    return {
      scheduledFor: scheduleAfter(now, hoursToMs(hours), context.demoTimeScale),
      basis: hours === 0 ? 'immediate' : 'static_table',
      nominalDelayHours: hours,
      recheckOnly: false,
      reason:
        hours === 0
          ? `${context.rootCause}: act immediately (POLICY_SPEC §4)`
          : `${context.rootCause}: static table, attempt ${context.attemptCount} → +${hours}h`,
    };
  }

  /**
   * TASK 3 — the payoff for Run 3's downtime signal.
   *
   * A retry timed to a known recovery instead of a guess. Two cases:
   *
   *  - **Resolved window**: schedule just after `resolved_at`. If that instant has
   *    already passed, act now — the outage is over and waiting a nominal 2h would
   *    delay a recovery for no reason.
   *  - **Open window**: schedule a RE-CHECK, not an action. The bank is still
   *    down; an attempt now is guaranteed to fail and would consume one of the
   *    three the attempt cap allows.
   */
  private scheduleFromDowntime(context: TimingContext, now: Date): TimingDecision | null {
    const window = context.downtimeWindow;
    if (!window) return null;
    if (context.rootCause !== 'issuer_down') return null;

    if (window.resolvedAt === null) {
      const hours = DOWNTIME_RECHECK_HOURS;
      return {
        scheduledFor: scheduleAfter(now, hoursToMs(hours), context.demoTimeScale),
        basis: 'downtime_recheck',
        nominalDelayHours: hours,
        // The critical bit: no money action while the outage is open.
        recheckOnly: true,
        reason:
          `issuer_down: outage for ${window.issuer ?? 'platform'} is still OPEN ` +
          `(started ${window.startedAt.toISOString()}); re-check in ${hours}h rather than ` +
          'burning an attempt against a bank that is down',
      };
    }

    const resumeAt = new Date(
      window.resolvedAt.getTime() + hoursToMs(DOWNTIME_RECOVERY_GRACE_HOURS),
    );

    if (resumeAt.getTime() <= now.getTime()) {
      return {
        scheduledFor: now,
        basis: 'downtime_resolved',
        nominalDelayHours: 0,
        recheckOnly: false,
        reason:
          `issuer_down: outage resolved at ${window.resolvedAt.toISOString()}, ` +
          'already past the grace period — retry now',
      };
    }

    // Scale the remaining wait so demo mode compresses it like any other delay.
    const remainingMs = resumeAt.getTime() - now.getTime();
    return {
      scheduledFor: scheduleAfter(now, remainingMs, context.demoTimeScale),
      basis: 'downtime_resolved',
      nominalDelayHours: remainingMs / HOUR_MS,
      recheckOnly: false,
      reason:
        `issuer_down: outage resolved at ${window.resolvedAt.toISOString()}; ` +
        `retry ${DOWNTIME_RECOVERY_GRACE_HOURS}h after recovery rather than a guessed +2h`,
    };
  }

  /**
   * The salary-cycle heuristic.
   *
   * Applied only when the window is genuinely later than the plain delay would be.
   * Otherwise a failure on the 2nd would be pushed a month forward to the next
   * window, which is the opposite of the intent.
   *
   * Labelled a heuristic in POLICY_SPEC and measured against a flat delay by the
   * eval. If it does not beat one, that is a finding worth reporting.
   */
  private scheduleFromSalaryWindow(context: TimingContext, now: Date): TimingDecision | null {
    if (context.rootCause !== 'insufficient_funds' && context.rootCause !== 'mandate_insufficient_balance') {
      return null;
    }

    const window = nextSalaryWindow(now, context.salaryWindowDays, SALARY_WINDOW_HOUR);
    // Fail closed: no usable window means fall through to the static table.
    if (!window) return null;

    const plainHours = staticDelayHours(context.rootCause, context.attemptCount);
    const plainInstant = new Date(now.getTime() + hoursToMs(plainHours));

    // Already inside or past the window: the plain delay is fine.
    if (window.getTime() <= plainInstant.getTime()) return null;

    const waitMs = window.getTime() - now.getTime();
    // Never wait more than a month for a balance to appear.
    if (waitMs > 31 * DAY_MS) return null;

    const clock = istClock(now);
    return {
      scheduledFor: scheduleAfter(now, waitMs, context.demoTimeScale),
      basis: 'salary_window',
      nominalDelayHours: waitMs / HOUR_MS,
      recheckOnly: false,
      reason:
        `${context.rootCause}: failed on the ${clock.day}th IST, so scheduled into the ` +
        `salary window (day ${context.salaryWindowDays.join('/')}) rather than +${plainHours}h`,
    };
  }
}
