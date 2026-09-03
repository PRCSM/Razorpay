/**
 * The synthetic case generator.
 *
 * Produces N labelled cases matching the distribution in
 * docs/EVAL_METHODOLOGY.md. Every case carries `is_synthetic = true` and a
 * `ground_truth` payload; every measured number in RESULTS.md comes from this
 * dataset, and none of it is ever blended with the live lane.
 *
 * Fully deterministic. Given the same `seed` and `count` the output is identical,
 * including timestamps — `referenceDate` is a parameter, never the clock. The
 * ORDER of random draws is part of the contract: reordering them changes the
 * dataset even at the same seed.
 */

import type { CaseSource, GroundTruth, PaymentMethod } from '@reflow/core';
import {
  AMOUNT_RANGES_PAISE,
  BURST_MAX_SIZE,
  BURST_MIN_SIZE,
  BURST_WINDOW_MINUTES,
  CAUSE_ERROR_SIGNATURES,
  CAUSE_GROUND_TRUTH,
  CAUSE_METHOD_MIX,
  CHECKOUT_CAUSE_MIX,
  ISSUERS,
  MANDATE_CAUSE_MIX,
  PAYMENT_CAUSE_MIX,
  RECEIVABLE_CAUSE_MIX,
  SALARY_SQUEEZE_CONCENTRATION,
  SALARY_SQUEEZE_DAY_MAX,
  SALARY_SQUEEZE_DAY_MIN,
  SIMULATION_WINDOW_DAYS,
  SOURCE_MIX,
  TERMINAL_CAUSES_GENERAL,
  TERMINAL_CAUSE_MANDATE,
  TERMINAL_GROUND_TRUTH,
  TERMINAL_SHARE,
  type CauseGroundTruth,
} from './distribution';
import { Rng } from './prng';
import {
  istDaysInRange,
  istDaysOutsideRange,
  utcFromIst,
  type IstDateParts,
} from './time';

/** One generated case, shaped for insertion into `recovery_cases`. */
export interface SyntheticCase {
  readonly source: CaseSource;
  readonly externalRef: string;
  /** Integer paise. */
  readonly amountPaise: number;
  readonly currency: string;
  /** Opaque synthetic token. Never a real identity. */
  readonly customerRef: string;
  readonly method: PaymentMethod | null;
  readonly issuer: string | null;
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly errorReason: string | null;
  readonly openedAt: Date;
  /** Convenience flag; the authoritative label is `groundTruth.true_root_cause`. */
  readonly isTerminal: boolean;
  readonly groundTruth: GroundTruth;
}

export interface GenerateOptions {
  readonly count: number;
  readonly seed: string | number;
  /**
   * End of the simulation window. Cases are spread over the preceding
   * SIMULATION_WINDOW_DAYS. Passed in so output is reproducible.
   */
  readonly referenceDate: Date;
}

/** Per-source id prefix, so an external_ref reads like its provider entity. */
const REF_PREFIX: Readonly<Record<CaseSource, string>> = {
  payment: 'pay',
  mandate: 'sub',
  checkout: 'order',
  receivable: 'inv',
};

function causeMixFor(source: CaseSource) {
  switch (source) {
    case 'payment':
      return PAYMENT_CAUSE_MIX;
    case 'mandate':
      return MANDATE_CAUSE_MIX;
    case 'checkout':
      return CHECKOUT_CAUSE_MIX;
    case 'receivable':
      return RECEIVABLE_CAUSE_MIX;
    default:
      return PAYMENT_CAUSE_MIX;
  }
}

/**
 * Method for a case.
 *
 * Checkout abandonment often has no method at all — the customer left before
 * choosing one — which is a realistic null that the normalizer and diagnosis both
 * have to cope with.
 */
function methodFor(source: CaseSource, cause: string, rng: Rng): PaymentMethod | null {
  if (source === 'mandate') return 'emandate';
  if (source === 'receivable') return rng.bool(0.5) ? 'netbanking' : null;
  if (source === 'checkout') {
    if (rng.bool(0.35)) return null;
    return rng.weighted([
      { value: 'upi', weight: 45 },
      { value: 'card', weight: 35 },
      { value: 'netbanking', weight: 12 },
      { value: 'wallet', weight: 8 },
    ]);
  }

  const mix = CAUSE_METHOD_MIX[cause];
  if (mix && mix.length > 0) return rng.weighted(mix);
  return rng.weighted([
    { value: 'card', weight: 50 },
    { value: 'upi', weight: 35 },
    { value: 'netbanking', weight: 15 },
  ]);
}

/**
 * Split `total` issuer_down cases into burst sizes, each in [8, 20].
 *
 * Real outages are correlated. docs/EVAL_METHODOLOGY.md: "If failures were
 * independent, a naive retry would look better than it deserves, because it would
 * never hit the same outage twice. Modelling the burst is what makes the baseline
 * fair."
 */
export function partitionIntoBursts(total: number, rng: Rng): readonly number[] {
  if (total <= 0) return [];
  // Degenerate only for tiny N: a single undersized burst beats inventing cases.
  if (total <= BURST_MAX_SIZE) return [total];

  const sizes: number[] = [];
  let remaining = total;

  while (remaining > BURST_MAX_SIZE) {
    let size = rng.int(BURST_MIN_SIZE, BURST_MAX_SIZE);
    // Never leave a tail too small to be a valid burst.
    if (remaining - size < BURST_MIN_SIZE) {
      size = remaining - BURST_MIN_SIZE;
    }
    sizes.push(size);
    remaining -= size;
  }
  sizes.push(remaining);
  return sizes;
}

function groundTruthFor(
  cause: string,
  isTerminal: boolean,
  rng: Rng,
): GroundTruth {
  const table: CauseGroundTruth = isTerminal
    ? TERMINAL_GROUND_TRUTH
    : (CAUSE_GROUND_TRUTH[cause] ?? {
        wouldPayEventually: 0.4,
        respondsTo: ['nudge', 'payment_link'],
        bestWindowHours: [6, 24],
      });

  const [windowMin, windowMax] = table.bestWindowHours;

  return {
    would_pay_eventually: isTerminal ? false : rng.bool(table.wouldPayEventually),
    responds_to: [...table.respondsTo],
    best_window_hours: windowMin === windowMax ? windowMin : rng.int(windowMin, windowMax),
    true_root_cause: cause,
  };
}

/** Draws that define a case, before a timestamp is attached. */
interface CaseSkeleton {
  readonly source: CaseSource;
  readonly cause: string;
  readonly isTerminal: boolean;
  readonly method: PaymentMethod | null;
  issuer: string | null;
  readonly amountPaise: number;
  readonly customerRef: string;
  readonly groundTruth: GroundTruth;
  openedAt: Date | null;
}

export function generateCases(options: GenerateOptions): readonly SyntheticCase[] {
  const { count, seed, referenceDate } = options;

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`generateCases: count must be a positive integer, got ${String(count)}`);
  }

  const rng = new Rng(seed);

  const windowEnd = referenceDate;
  const windowStart = new Date(
    referenceDate.getTime() - SIMULATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  /**
   * A customer pool smaller than the case count, so some customers appear in
   * several cases. That is what makes the cross-case contact cap (gate 3)
   * meaningful — with one case per customer it could never fire.
   */
  const customerPoolSize = Math.max(1, Math.ceil(count * 0.72));
  const customerPool: string[] = [];
  for (let i = 0; i < customerPoolSize; i += 1) {
    customerPool.push(`cust_synth_${String(i).padStart(5, '0')}`);
  }

  // ---- phase 1: attributes -------------------------------------------------
  const skeletons: CaseSkeleton[] = [];
  for (let i = 0; i < count; i += 1) {
    const source = rng.weighted(SOURCE_MIX);
    const isTerminal = rng.bool(TERMINAL_SHARE);

    const cause = isTerminal
      ? source === 'mandate' && rng.bool(0.5)
        ? TERMINAL_CAUSE_MANDATE
        : rng.pick(TERMINAL_CAUSES_GENERAL)
      : rng.weighted(causeMixFor(source));

    const method = methodFor(source, cause, rng);
    const issuer = method === null ? null : rng.pick(ISSUERS);

    const range = AMOUNT_RANGES_PAISE[source];
    const amountPaise = rng.logUniformInt(range[0], range[1]);

    const customerRef = rng.pick(customerPool);
    const groundTruth = groundTruthFor(cause, isTerminal, rng);

    skeletons.push({
      source,
      cause,
      isTerminal,
      method,
      issuer,
      amountPaise,
      customerRef,
      groundTruth,
      openedAt: null,
    });
  }

  // ---- phase 2a: bursty issuer_down ---------------------------------------
  const burstIndices = skeletons
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.cause === 'issuer_down')
    .map(({ index }) => index);

  const burstSizes = partitionIntoBursts(burstIndices.length, rng);
  let cursor = 0;
  const burstWindowMs = BURST_WINDOW_MINUTES * 60 * 1000;
  const latestBurstStart = windowEnd.getTime() - burstWindowMs;

  for (const size of burstSizes) {
    // One outage hits one bank. Sharing the issuer across the burst is what makes
    // the correlation visible to the bandit's issuer × method bucket.
    const burstIssuer = rng.pick(ISSUERS);
    const burstStart = rng.int(windowStart.getTime(), Math.max(windowStart.getTime(), latestBurstStart));

    for (let k = 0; k < size; k += 1) {
      const index = burstIndices[cursor];
      cursor += 1;
      if (index === undefined) break;
      const skeleton = skeletons[index];
      if (skeleton === undefined) continue;
      skeleton.issuer = burstIssuer;
      skeleton.openedAt = new Date(burstStart + rng.int(0, burstWindowMs - 1));
    }
  }

  // ---- phase 2b: insufficient_funds clusters in the salary squeeze ---------
  // A cluster, not a hard constraint: SALARY_SQUEEZE_CONCENTRATION of these
  // cases land in the 18th-28th, the rest spread across the remaining days.
  const salaryDays = istDaysInRange(
    windowStart,
    windowEnd,
    SALARY_SQUEEZE_DAY_MIN,
    SALARY_SQUEEZE_DAY_MAX,
  );
  const nonSalaryDays = istDaysOutsideRange(
    windowStart,
    windowEnd,
    SALARY_SQUEEZE_DAY_MIN,
    SALARY_SQUEEZE_DAY_MAX,
  );

  for (const skeleton of skeletons) {
    if (skeleton.openedAt !== null) continue;
    if (skeleton.cause !== 'insufficient_funds') continue;

    const inSqueeze = rng.bool(SALARY_SQUEEZE_CONCENTRATION);
    const pool = inSqueeze ? salaryDays : nonSalaryDays;

    if (pool.length === 0) {
      skeleton.openedAt = new Date(rng.int(windowStart.getTime(), windowEnd.getTime()));
      continue;
    }
    const day: IstDateParts = rng.pick(pool);
    skeleton.openedAt = utcFromIst(day.year, day.month, day.day, rng.int(0, 23), rng.int(0, 59));
  }

  // ---- phase 2c: everything else, uniform ---------------------------------
  for (const skeleton of skeletons) {
    if (skeleton.openedAt !== null) continue;
    skeleton.openedAt = new Date(rng.int(windowStart.getTime(), windowEnd.getTime()));
  }

  // ---- assemble ------------------------------------------------------------
  return skeletons.map((skeleton, index) => {
    const signature = CAUSE_ERROR_SIGNATURES[skeleton.cause];
    const openedAt = skeleton.openedAt ?? windowEnd;

    // Checkout abandonment has no provider error — nobody rejected anything.
    const isCheckout = skeleton.source === 'checkout';

    return {
      source: skeleton.source,
      externalRef: `${REF_PREFIX[skeleton.source]}_synth_${String(index).padStart(5, '0')}`,
      amountPaise: skeleton.amountPaise,
      currency: 'INR',
      customerRef: skeleton.customerRef,
      method: skeleton.method,
      issuer: skeleton.issuer,
      errorCode: isCheckout ? null : (signature?.errorCode ?? null),
      errorSource: isCheckout ? null : (signature?.errorSource ?? null),
      errorStep: isCheckout ? null : (signature?.errorStep ?? null),
      errorReason: isCheckout ? skeleton.cause : (signature?.errorReason ?? null),
      openedAt,
      isTerminal: skeleton.isTerminal,
      groundTruth: skeleton.groundTruth,
    } satisfies SyntheticCase;
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface DistributionReport {
  readonly total: number;
  readonly bySource: Readonly<Record<string, number>>;
  readonly terminalCount: number;
  readonly terminalShare: number;
  /** Cause shares among NON-terminal payment cases. */
  readonly paymentCauses: Readonly<Record<string, number>>;
  readonly paymentNonTerminal: number;
  readonly issuerDownBursts: readonly { size: number; issuer: string; startIso: string }[];
  readonly insufficientFundsInSalaryWindow: number;
  readonly insufficientFundsTotal: number;
  readonly withGroundTruth: number;
  readonly uniqueCustomers: number;
  readonly amountPaiseTotal: number;
}

/**
 * Summarise a generated batch.
 *
 * Printed by the seed script so the distribution can be eyeballed rather than
 * taken on trust.
 */
export function describeDistribution(cases: readonly SyntheticCase[]): DistributionReport {
  const bySource: Record<string, number> = {};
  const paymentCauses: Record<string, number> = {};
  const customers = new Set<string>();

  let terminalCount = 0;
  let paymentNonTerminal = 0;
  let withGroundTruth = 0;
  let amountPaiseTotal = 0;
  let insufficientFundsTotal = 0;
  let insufficientFundsInSalaryWindow = 0;

  for (const c of cases) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    customers.add(c.customerRef);
    amountPaiseTotal += c.amountPaise;

    if (c.isTerminal) terminalCount += 1;

    if (c.source === 'payment' && !c.isTerminal) {
      paymentNonTerminal += 1;
      const cause = c.groundTruth.true_root_cause;
      paymentCauses[cause] = (paymentCauses[cause] ?? 0) + 1;
    }

    if (c.groundTruth.true_root_cause === 'insufficient_funds') {
      insufficientFundsTotal += 1;
    }

    if (
      Array.isArray(c.groundTruth.responds_to) &&
      typeof c.groundTruth.would_pay_eventually === 'boolean' &&
      typeof c.groundTruth.best_window_hours === 'number' &&
      typeof c.groundTruth.true_root_cause === 'string'
    ) {
      withGroundTruth += 1;
    }
  }

  // Salary-window check, in IST.
  for (const c of cases) {
    if (c.groundTruth.true_root_cause !== 'insufficient_funds') continue;
    const istDay = new Date(c.openedAt.getTime() + 5.5 * 60 * 60 * 1000).getUTCDate();
    if (istDay >= SALARY_SQUEEZE_DAY_MIN && istDay <= SALARY_SQUEEZE_DAY_MAX) {
      insufficientFundsInSalaryWindow += 1;
    }
  }

  // Reconstruct bursts: issuer_down cases grouped by 30-minute proximity.
  const downCases = cases
    .filter((c) => c.groundTruth.true_root_cause === 'issuer_down')
    .slice()
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

  const bursts: { size: number; issuer: string; startIso: string }[] = [];
  let current: { size: number; issuer: string; start: number } | null = null;
  const windowMs = BURST_WINDOW_MINUTES * 60 * 1000;

  for (const c of downCases) {
    const t = c.openedAt.getTime();
    if (current && c.issuer === current.issuer && t - current.start <= windowMs) {
      current.size += 1;
      continue;
    }
    if (current) bursts.push({ size: current.size, issuer: current.issuer, startIso: new Date(current.start).toISOString() });
    current = { size: 1, issuer: c.issuer ?? 'unknown', start: t };
  }
  if (current) {
    bursts.push({ size: current.size, issuer: current.issuer, startIso: new Date(current.start).toISOString() });
  }

  return {
    total: cases.length,
    bySource,
    terminalCount,
    terminalShare: cases.length === 0 ? 0 : terminalCount / cases.length,
    paymentCauses,
    paymentNonTerminal,
    issuerDownBursts: bursts,
    insufficientFundsInSalaryWindow,
    insufficientFundsTotal,
    withGroundTruth,
    uniqueCustomers: customers.size,
    amountPaiseTotal,
  };
}

/**
 * A stable fingerprint of a batch.
 *
 * Used to prove determinism: same seed, byte-identical output. Every field that
 * defines a case is included, timestamps to the millisecond.
 */
export function fingerprintCases(cases: readonly SyntheticCase[]): string {
  return cases
    .map((c) =>
      [
        c.source,
        c.externalRef,
        c.amountPaise,
        c.currency,
        c.customerRef,
        c.method ?? '-',
        c.issuer ?? '-',
        c.errorCode ?? '-',
        c.errorSource ?? '-',
        c.errorStep ?? '-',
        c.errorReason ?? '-',
        c.openedAt.toISOString(),
        c.isTerminal ? 'T' : 'N',
        c.groundTruth.true_root_cause,
        c.groundTruth.would_pay_eventually ? 'y' : 'n',
        c.groundTruth.best_window_hours,
        [...c.groundTruth.responds_to].join('+'),
      ].join('|'),
    )
    .join('\n');
}
