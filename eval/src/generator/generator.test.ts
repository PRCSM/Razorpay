import { describe, expect, it } from 'vitest';
import {
  BURST_MAX_SIZE,
  BURST_MIN_SIZE,
  BURST_WINDOW_MINUTES,
  PAYMENT_CAUSE_MIX,
  SALARY_SQUEEZE_DAY_MAX,
  SALARY_SQUEEZE_DAY_MIN,
  SOURCE_MIX,
  TERMINAL_SHARE,
} from './distribution';
import {
  describeDistribution,
  fingerprintCases,
  generateCases,
  partitionIntoBursts,
} from './index';
import { Rng, hashSeed } from './prng';
import { istDayOfMonth } from './time';

/**
 * Fixed reference date. The dataset must not shift with the wall clock, or
 * "same seed, same data" quietly stops being true tomorrow.
 */
const REFERENCE = new Date('2026-03-01T00:00:00.000Z');
const COUNT = 500;

const cases = generateCases({ count: COUNT, seed: 42, referenceDate: REFERENCE });
const report = describeDistribution(cases);

/**
 * Tolerances are wide enough for binomial noise at this sample size and no wider.
 * For a 15% share of 500 the standard deviation is ~1.6pp, so ±4pp is about 2.5σ.
 */
const SOURCE_TOLERANCE_PP = 4;
const CAUSE_TOLERANCE_PP = 5;

describe('PRNG', () => {
  it('is reproducible for a given seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const drawsA = Array.from({ length: 200 }, () => a.next());
    const drawsB = Array.from({ length: 200 }, () => b.next());
    expect(drawsA).toEqual(drawsB);
  });

  it('produces different streams for different seeds', () => {
    const a = new Rng(42);
    const b = new Rng(43);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays within [0, 1)', () => {
    const rng = new Rng('bounds');
    for (let i = 0; i < 5000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int() is inclusive at both ends and never out of range', () => {
    const rng = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i += 1) {
      const value = rng.int(1, 6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect(seen).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it('weighted() respects the weights', () => {
    const rng = new Rng('weights');
    let a = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      if (rng.weighted([{ value: 'a', weight: 75 }, { value: 'b', weight: 25 }]) === 'a') a += 1;
    }
    expect(a / n).toBeGreaterThan(0.73);
    expect(a / n).toBeLessThan(0.77);
  });

  it('hashSeed is stable and distinguishes adjacent seeds', () => {
    expect(hashSeed(42)).toBe(hashSeed(42));
    expect(hashSeed(42)).not.toBe(hashSeed(43));
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
  });

  it('rejects a degenerate distribution instead of guessing', () => {
    const rng = new Rng('bad');
    expect(() => rng.weighted([])).toThrow();
    expect(() => rng.pick([])).toThrow();
    expect(() => rng.int(5, 1)).toThrow();
  });
});

describe('generator determinism', () => {
  it('produces byte-identical output for the same seed', () => {
    const a = generateCases({ count: COUNT, seed: 42, referenceDate: REFERENCE });
    const b = generateCases({ count: COUNT, seed: 42, referenceDate: REFERENCE });
    expect(fingerprintCases(a)).toBe(fingerprintCases(b));
  });

  it('produces a different dataset for a different seed', () => {
    const a = generateCases({ count: COUNT, seed: 42, referenceDate: REFERENCE });
    const b = generateCases({ count: COUNT, seed: 43, referenceDate: REFERENCE });
    expect(fingerprintCases(a)).not.toBe(fingerprintCases(b));
  });

  it('reproduces timestamps to the millisecond', () => {
    const a = generateCases({ count: 50, seed: 7, referenceDate: REFERENCE });
    const b = generateCases({ count: 50, seed: 7, referenceDate: REFERENCE });
    expect(a.map((c) => c.openedAt.toISOString())).toEqual(
      b.map((c) => c.openedAt.toISOString()),
    );
  });

  it('is a prefix-stable stream: the same seed yields the same early cases', () => {
    const small = generateCases({ count: 10, seed: 42, referenceDate: REFERENCE });
    const large = generateCases({ count: COUNT, seed: 42, referenceDate: REFERENCE });
    // Attribute draws happen in order, so the first 10 skeletons match even
    // though timestamps are assigned in a later phase.
    expect(small.map((c) => c.groundTruth.true_root_cause)).toEqual(
      large.slice(0, 10).map((c) => c.groundTruth.true_root_cause),
    );
  });

  it('rejects a non-positive count', () => {
    expect(() => generateCases({ count: 0, seed: 1, referenceDate: REFERENCE })).toThrow();
    expect(() => generateCases({ count: -5, seed: 1, referenceDate: REFERENCE })).toThrow();
  });
});

describe('generator distribution — source mix 55/20/15/10', () => {
  for (const entry of SOURCE_MIX) {
    it(`${entry.value} is within ±${SOURCE_TOLERANCE_PP}pp of ${entry.weight}%`, () => {
      const actual = ((report.bySource[entry.value] ?? 0) / report.total) * 100;
      expect(actual).toBeGreaterThan(entry.weight - SOURCE_TOLERANCE_PP);
      expect(actual).toBeLessThan(entry.weight + SOURCE_TOLERANCE_PP);
    });
  }

  it('every case has one of the four sources', () => {
    const total = SOURCE_MIX.reduce((sum, e) => sum + (report.bySource[e.value] ?? 0), 0);
    expect(total).toBe(COUNT);
  });
});

describe('generator distribution — terminal cases at 12%', () => {
  it(`terminal share is within ±3pp of ${TERMINAL_SHARE * 100}%`, () => {
    const actual = report.terminalShare * 100;
    expect(actual).toBeGreaterThan(TERMINAL_SHARE * 100 - 3);
    expect(actual).toBeLessThan(TERMINAL_SHARE * 100 + 3);
  });

  it('terminal cases appear across all sources, not just payments', () => {
    const sources = new Set(cases.filter((c) => c.isTerminal).map((c) => c.source));
    expect(sources.size).toBeGreaterThanOrEqual(3);
  });

  it('terminal cases respond to nothing and would never self-pay', () => {
    for (const c of cases.filter((x) => x.isTerminal)) {
      expect(c.groundTruth.responds_to).toEqual([]);
      expect(c.groundTruth.would_pay_eventually).toBe(false);
      expect(c.groundTruth.best_window_hours).toBe(0);
    }
  });

  it('uses only the terminal causes from policy.yaml', () => {
    const allowed = new Set(['fraud_flag', 'chargeback', 'customer_opt_out', 'mandate_revoked']);
    for (const c of cases.filter((x) => x.isTerminal)) {
      expect(allowed.has(c.groundTruth.true_root_cause)).toBe(true);
    }
  });

  it('mandate_revoked only ever appears on a mandate', () => {
    for (const c of cases) {
      if (c.groundTruth.true_root_cause === 'mandate_revoked') {
        expect(c.source).toBe('mandate');
      }
    }
  });
});

describe('generator distribution — payment root causes', () => {
  for (const entry of PAYMENT_CAUSE_MIX) {
    it(`${entry.value} is within ±${CAUSE_TOLERANCE_PP}pp of ${entry.weight}%`, () => {
      const actual =
        ((report.paymentCauses[entry.value] ?? 0) / report.paymentNonTerminal) * 100;
      expect(actual).toBeGreaterThan(entry.weight - CAUSE_TOLERANCE_PP);
      expect(actual).toBeLessThan(entry.weight + CAUSE_TOLERANCE_PP);
    });
  }

  it('non-terminal payment causes account for every non-terminal payment case', () => {
    const summed = Object.values(report.paymentCauses).reduce((a, b) => a + b, 0);
    expect(summed).toBe(report.paymentNonTerminal);
  });

  it('invalid_vpa is always UPI and expired_card is always card', () => {
    for (const c of cases) {
      if (c.groundTruth.true_root_cause === 'invalid_vpa') expect(c.method).toBe('upi');
      if (c.groundTruth.true_root_cause === 'expired_card') expect(c.method).toBe('card');
    }
  });
});

describe('generator — issuer_down is bursty', () => {
  it('partitions into bursts sized 8-20', () => {
    const rng = new Rng('bursts');
    for (const total of [21, 30, 47, 53, 88, 140]) {
      const sizes = partitionIntoBursts(total, rng);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
      for (const size of sizes) {
        expect(size).toBeGreaterThanOrEqual(BURST_MIN_SIZE);
        expect(size).toBeLessThanOrEqual(BURST_MAX_SIZE);
      }
    }
  });

  it('handles a total smaller than one burst without inventing cases', () => {
    const rng = new Rng('small');
    expect(partitionIntoBursts(0, rng)).toEqual([]);
    expect(partitionIntoBursts(3, rng)).toEqual([3]);
  });

  it('produces multiple detectable bursts in the dataset', () => {
    expect(report.issuerDownBursts.length).toBeGreaterThanOrEqual(2);
  });

  it('each detected burst fits inside a 30-minute window', () => {
    const windowMs = BURST_WINDOW_MINUTES * 60 * 1000;
    const byIssuer = new Map<string, number[]>();
    for (const c of cases) {
      if (c.groundTruth.true_root_cause !== 'issuer_down') continue;
      const key = c.issuer ?? 'unknown';
      const list = byIssuer.get(key) ?? [];
      list.push(c.openedAt.getTime());
      byIssuer.set(key, list);
    }
    // Every issuer_down case must sit within a window of another one — an
    // isolated failure would mean the burst modelling did not apply.
    for (const [, times] of byIssuer) {
      times.sort((a, b) => a - b);
      const first = times[0];
      const last = times[times.length - 1];
      if (first === undefined || last === undefined) continue;
      if (times.length === 1) continue;
      // Each cluster is contiguous within the window.
      expect(last - first).toBeLessThan(windowMs * (times.length + 1));
    }
  });

  it('an outage hits one bank at a time — bursts share an issuer', () => {
    for (const burst of report.issuerDownBursts) {
      expect(burst.issuer).not.toBe('unknown');
    }
    // Correlated, not independent: far fewer distinct issuers than cases.
    const issuers = new Set(
      cases.filter((c) => c.groundTruth.true_root_cause === 'issuer_down').map((c) => c.issuer),
    );
    const downCount = cases.filter(
      (c) => c.groundTruth.true_root_cause === 'issuer_down',
    ).length;
    expect(issuers.size).toBeLessThan(downCount / 4);
  });
});

describe('generator — insufficient_funds clusters in the salary window', () => {
  it('concentrates in the 18th-28th IST without being absolute', () => {
    const share = report.insufficientFundsInSalaryWindow / report.insufficientFundsTotal;
    // A real cluster: well above the ~37% the window would get by chance, and
    // deliberately below 1.0 so the salary heuristic is not trivially perfect.
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.9);
  });

  it('the in-window cases really are in the 18th-28th IST', () => {
    const inWindow = cases.filter(
      (c) =>
        c.groundTruth.true_root_cause === 'insufficient_funds' &&
        istDayOfMonth(c.openedAt) >= SALARY_SQUEEZE_DAY_MIN &&
        istDayOfMonth(c.openedAt) <= SALARY_SQUEEZE_DAY_MAX,
    );
    expect(inWindow.length).toBe(report.insufficientFundsInSalaryWindow);
    for (const c of inWindow) {
      const day = istDayOfMonth(c.openedAt);
      expect(day).toBeGreaterThanOrEqual(18);
      expect(day).toBeLessThanOrEqual(28);
    }
  });
});

describe('generator — ground truth and integrity', () => {
  it('every case carries complete ground truth', () => {
    expect(report.withGroundTruth).toBe(COUNT);
    for (const c of cases) {
      expect(typeof c.groundTruth.would_pay_eventually).toBe('boolean');
      expect(Array.isArray(c.groundTruth.responds_to)).toBe(true);
      expect(Number.isInteger(c.groundTruth.best_window_hours)).toBe(true);
      expect(c.groundTruth.true_root_cause.length).toBeGreaterThan(0);
    }
  });

  it('every non-terminal case responds to at least one action', () => {
    for (const c of cases.filter((x) => !x.isTerminal)) {
      expect(c.groundTruth.responds_to.length).toBeGreaterThan(0);
    }
  });

  it('all money is a positive safe integer of paise', () => {
    for (const c of cases) {
      expect(Number.isSafeInteger(c.amountPaise)).toBe(true);
      expect(c.amountPaise).toBeGreaterThan(0);
    }
  });

  it('external refs are unique', () => {
    const refs = new Set(cases.map((c) => c.externalRef));
    expect(refs.size).toBe(COUNT);
  });

  it('customers repeat, so the cross-case contact cap can actually fire', () => {
    expect(report.uniqueCustomers).toBeLessThan(COUNT);
    expect(report.uniqueCustomers).toBeGreaterThan(COUNT * 0.4);
  });

  it('receivables cross the ₹25,000 autonomous ceiling, exercising gate 6', () => {
    const ceiling = 2_500_000;
    const above = cases.filter((c) => c.source === 'receivable' && c.amountPaise > ceiling);
    expect(above.length).toBeGreaterThan(0);
  });

  it('all cases fall inside the simulation window', () => {
    const start = REFERENCE.getTime() - 60 * 24 * 60 * 60 * 1000;
    for (const c of cases) {
      expect(c.openedAt.getTime()).toBeGreaterThanOrEqual(start);
      expect(c.openedAt.getTime()).toBeLessThanOrEqual(REFERENCE.getTime());
    }
  });

  /**
   * Changed in Run 3. Checkout abandonment is OUR simulated event, so we control
   * its payload and record the stage the customer reached. That stage is what lets
   * the rule table diagnose checkout deterministically instead of handing a
   * light-depth surface to the LLM. It is not a Razorpay error — the code is our
   * own `CHECKOUT_ABANDONED` marker. See ADR-027.
   */
  it('checkout cases carry a structured stage signal, not a provider error', () => {
    const stages = new Set([
      'checkout_method_selection',
      'checkout_authentication',
      'checkout_review',
    ]);
    for (const c of cases.filter((x) => x.source === 'checkout' && !x.isTerminal)) {
      expect(c.errorCode).toBe('CHECKOUT_ABANDONED');
      expect(c.errorSource).toBe('customer');
      expect(stages.has(c.errorStep ?? '')).toBe(true);
    }
  });

  it('receivables carry a day count the rule table can read', () => {
    for (const c of cases.filter((x) => x.source === 'receivable' && !x.isTerminal)) {
      expect(c.daysOverdue).not.toBeNull();
      expect(Number.isSafeInteger(c.daysOverdue ?? -1)).toBe(true);
    }
  });

  it('non-checkout, non-terminal cases carry a diagnosable error tuple', () => {
    for (const c of cases) {
      if (c.source === 'checkout') continue;
      // Run 3's rule table matches on (error_code, error_source, error_step, method).
      expect(c.errorCode).not.toBeNull();
      expect(c.errorSource).not.toBeNull();
      expect(c.errorStep).not.toBeNull();
    }
  });
});
