/**
 * The timing strategy interface.
 *
 * docs/POLICY_SPEC.md §4: timing sits behind an interface so the static table
 * ships first and the bandit is config-selected. Both receive `now` as a
 * parameter — the purity fence in `eslint.config.mjs` blocks `Date.now()` here.
 */

import type { PaymentMethod } from '../types/enums';
import type { DowntimeWindow } from '../diagnose/downtime';

/** Everything a strategy may consider. Deliberately plain data. */
export interface TimingContext {
  readonly rootCause: string;
  readonly issuer: string | null;
  readonly method: PaymentMethod | null;
  /** How many attempts have already been made on this case. 0 for the first plan. */
  readonly attemptCount: number;
  /** From policy.yaml `timing.salary_window_days`. */
  readonly salaryWindowDays: readonly number[];
  /** From `DEMO_TIME_SCALE`. Applied through `scaleDelayMs`, never here. */
  readonly demoTimeScale: number;
  /**
   * The downtime window covering this failure, when diagnosis found one.
   * Present only when `causeBy === 'downtime_signal'`.
   */
  readonly downtimeWindow?: DowntimeWindow | null;
}

/** Why a particular instant was chosen. Recorded so a schedule is explainable. */
export type TimingBasis =
  | 'static_table'
  | 'salary_window'
  | 'downtime_resolved'
  | 'downtime_recheck'
  | 'bandit_sample'
  | 'bandit_cold_fallback'
  | 'immediate';

export interface TimingDecision {
  readonly scheduledFor: Date;
  readonly basis: TimingBasis;
  /** Unscaled delay, for the audit record. The applied delay is scaled. */
  readonly nominalDelayHours: number;
  /** Set when the bandit chose an arm, so the outcome can update that arm. */
  readonly banditArm?: string;
  readonly banditBucketKey?: string;
  /**
   * True when the plan should be a re-check rather than a money action —
   * an issuer outage that has not resolved yet.
   */
  readonly recheckOnly: boolean;
  readonly reason: string;
}

export interface TimingStrategy {
  readonly name: 'static' | 'bandit';
  schedule(context: TimingContext, now: Date): TimingDecision;
}
