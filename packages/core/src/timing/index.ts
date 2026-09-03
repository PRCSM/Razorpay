/**
 * Timing strategy selection.
 *
 * `TIMING_STRATEGY` chooses; static is the default and the baseline the bandit is
 * measured against. policy.yaml's `timing.strategy` is the document default and the
 * env var overrides it (docs/ENVIRONMENT_VARIABLES.md).
 */

import type { PolicyConfig } from '../policy/schema';
import { BanditTimingStrategy, type BanditArm, type RandomSource } from './bandit-strategy';
import { StaticTimingStrategy } from './static-strategy';
import type { TimingStrategy } from './strategy';

export interface StrategySelection {
  /** From `TIMING_STRATEGY`. Omit to use policy.yaml's `timing.strategy`. */
  readonly requested?: 'static' | 'bandit' | undefined;
  readonly policy: PolicyConfig;
  /** Loaded `bandit_arms` rows. Empty is fine — cold buckets fall back. */
  readonly arms?: readonly BanditArm[];
  /** Required for the bandit. Injected so sampling is reproducible. */
  readonly random?: RandomSource;
}

/**
 * Build the configured strategy.
 *
 * Falls back to static when the bandit is asked for but no RNG was supplied —
 * silently reaching for `Math.random()` would break reproducibility, and the
 * purity fence forbids it anyway.
 */
export function selectTimingStrategy(selection: StrategySelection): TimingStrategy {
  const requested = selection.requested ?? selection.policy.timing.strategy;

  if (requested !== 'bandit') return new StaticTimingStrategy();

  if (!selection.random) return new StaticTimingStrategy();

  return new BanditTimingStrategy({
    arms: selection.arms ?? [],
    armHours: selection.policy.timing.bandit_arms_hours,
    random: selection.random,
  });
}

export {
  DAY_MS,
  HOUR_MS,
  IST_OFFSET_MS,
  MINUTE_MS,
  daysInMonth,
  hoursToMs,
  istClock,
  istMinutesOfDay,
  isWithinDailyWindow,
  nextIstTimeOfDay,
  nextSalaryWindow,
  parseTimeOfDay,
  scaleDelayMs,
  scheduleAfter,
  utcFromIst,
  type IstClock,
} from './clock';

export {
  STATIC_DELAY_HOURS,
  StaticTimingStrategy,
  staticDelayHours,
} from './static-strategy';

export {
  BanditTimingStrategy,
  armToHours,
  banditBucketKey,
  hoursToArm,
  sampleBeta,
  type BanditArm,
  type BanditOptions,
  type RandomSource,
} from './bandit-strategy';

export type {
  TimingBasis,
  TimingContext,
  TimingDecision,
  TimingStrategy,
} from './strategy';
