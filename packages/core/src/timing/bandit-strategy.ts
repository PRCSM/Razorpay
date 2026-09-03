/**
 * `BanditTimingStrategy` — Beta-Bernoulli Thompson sampling over retry delays.
 *
 * docs/POLICY_SPEC.md §4: bucket key `issuer:method:root_cause`, arms from
 * policy.yaml (`2h`, `6h`, `18h`, `48h`). Sample `Beta(alpha, beta)` per arm, take
 * the max. Success → `alpha += 1`. Failure → `beta += 1`. A cold bucket falls back
 * to the static table.
 *
 * "Deliberately simple — roughly 60 lines. A more sophisticated model cannot be
 * validated inside a six-day dataset, and unvalidated sophistication is worse than
 * a documented heuristic."
 *
 * PURE. `now` and the RNG both arrive as parameters — the purity fence blocks both
 * `Date.now()` and `Math.random()` here, which is what makes an arm comparison in
 * the eval reproducible rather than noise.
 */

import { hoursToMs, scheduleAfter } from './clock';
import { StaticTimingStrategy } from './static-strategy';
import type { TimingContext, TimingDecision, TimingStrategy } from './strategy';

/** Posterior state for one arm. Mirrors a `bandit_arms` row. */
export interface BanditArm {
  readonly bucketKey: string;
  /** e.g. '2h'. */
  readonly arm: string;
  /** Successes + 1. */
  readonly alpha: number;
  /** Failures + 1. */
  readonly beta: number;
}

/** A deterministic uniform source in [0, 1). Injected, never ambient. */
export type RandomSource = () => number;

/**
 * The bucket key, `issuer:method:root_cause`.
 *
 * Missing issuer or method become `unknown` rather than being dropped, so every
 * case lands in some bucket. Collapsing them into one shared key would mix
 * genuinely different failure modes.
 */
export function banditBucketKey(context: {
  readonly issuer: string | null;
  readonly method: string | null;
  readonly rootCause: string;
}): string {
  const issuer = context.issuer?.trim().toLowerCase() || 'unknown';
  const method = context.method?.trim().toLowerCase() || 'unknown';
  return `${issuer}:${method}:${context.rootCause}`;
}

/** `'2h'` → 2. Returns null when unparseable, so a bad arm is skipped not guessed. */
export function armToHours(arm: string): number | null {
  const match = /^(\d+(?:\.\d+)?)h$/i.exec(arm.trim());
  if (!match?.[1]) return null;
  const hours = Number(match[1]);
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

export function hoursToArm(hours: number): string {
  return `${hours}h`;
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia–Tsang, for shape >= 1.
 * Beta(a, b) is then `x / (x + y)` with `x ~ Gamma(a)` and `y ~ Gamma(b)`.
 *
 * Needed because there is no closed-form inverse Beta CDF. Boosted for shape < 1
 * via the standard `u^(1/shape)` correction.
 */
function sampleGamma(shape: number, random: RandomSource): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0;

  if (shape < 1) {
    const boosted = sampleGamma(shape + 1, random);
    const u = Math.max(random(), Number.EPSILON);
    return boosted * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  // Bounded so a degenerate RNG cannot spin forever.
  for (let i = 0; i < 200; i += 1) {
    // Box–Muller for a standard normal.
    const u1 = Math.max(random(), Number.EPSILON);
    const u2 = random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const v = 1 + c * normal;
    if (v <= 0) continue;

    const v3 = v * v * v;
    const u = Math.max(random(), Number.EPSILON);
    if (Math.log(u) < 0.5 * normal * normal + d * (1 - v3 + Math.log(v3))) {
      return d * v3;
    }
  }
  // Fall back to the mean rather than looping.
  return shape;
}

/** Draw from Beta(alpha, beta). */
export function sampleBeta(alpha: number, beta: number, random: RandomSource): number {
  const a = Number.isFinite(alpha) && alpha > 0 ? alpha : 1;
  const b = Number.isFinite(beta) && beta > 0 ? beta : 1;

  const x = sampleGamma(a, random);
  const y = sampleGamma(b, random);
  const total = x + y;
  // Both draws degenerate: return the posterior mean rather than NaN.
  if (!Number.isFinite(total) || total <= 0) return a / (a + b);
  return x / total;
}

export interface BanditOptions {
  /** Arms for this bucket, loaded from `bandit_arms`. Empty means a cold bucket. */
  readonly arms: readonly BanditArm[];
  /** Candidate delays from policy.yaml `timing.bandit_arms_hours`. */
  readonly armHours: readonly number[];
  readonly random: RandomSource;
}

export class BanditTimingStrategy implements TimingStrategy {
  public readonly name = 'bandit' as const;

  private readonly fallback = new StaticTimingStrategy();

  constructor(private readonly options: BanditOptions) {}

  schedule(context: TimingContext, now: Date): TimingDecision {
    // Downtime and the salary window are policy, not exploration. The bandit
    // tunes an ordinary delay; it does not get to ignore a known outage.
    const deterministic = this.fallback.schedule(context, now);
    if (deterministic.basis === 'downtime_recheck' || deterministic.basis === 'downtime_resolved') {
      return deterministic;
    }

    const bucketKey = banditBucketKey(context);
    const candidates = this.options.armHours
      .filter((h) => Number.isFinite(h) && h >= 0)
      .map((h) => hoursToArm(h));

    // No usable arm list: fall back rather than invent a delay.
    if (candidates.length === 0) {
      return { ...this.fallback.schedule(context, now), basis: 'bandit_cold_fallback' };
    }

    const forBucket = this.options.arms.filter((a) => a.bucketKey === bucketKey);

    /**
     * A cold bucket degrades to the static table rather than to a uniform guess.
     * docs/DATABASE_DESIGN.md: "Empty table → static timing table. The system
     * degrades to sensible defaults rather than to nothing."
     */
    if (forBucket.length === 0) {
      const base = this.fallback.schedule(context, now);
      return {
        ...base,
        basis: 'bandit_cold_fallback',
        banditBucketKey: bucketKey,
        reason: `${base.reason} (bandit: no observations for ${bucketKey}, using static)`,
      };
    }

    let bestArm: string | null = null;
    let bestSample = -1;

    for (const arm of candidates) {
      const state = forBucket.find((a) => a.arm === arm);
      // An arm with no row yet gets the uniform prior Beta(1,1), so it stays
      // explorable instead of being silently excluded.
      const alpha = state?.alpha ?? 1;
      const beta = state?.beta ?? 1;

      const sample = sampleBeta(alpha, beta, this.options.random);
      if (sample > bestSample) {
        bestSample = sample;
        bestArm = arm;
      }
    }

    const hours = bestArm === null ? null : armToHours(bestArm);
    if (bestArm === null || hours === null) {
      const base = this.fallback.schedule(context, now);
      return { ...base, basis: 'bandit_cold_fallback', banditBucketKey: bucketKey };
    }

    return {
      scheduledFor: scheduleAfter(now, hoursToMs(hours), context.demoTimeScale),
      basis: 'bandit_sample',
      nominalDelayHours: hours,
      banditArm: bestArm,
      banditBucketKey: bucketKey,
      recheckOnly: false,
      reason:
        `${context.rootCause}: Thompson sampling picked ${bestArm} for ${bucketKey} ` +
        `(posterior draw ${bestSample.toFixed(3)})`,
    };
  }
}
