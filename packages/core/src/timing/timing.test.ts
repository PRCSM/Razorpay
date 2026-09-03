import { describe, expect, it } from 'vitest';
import type { DowntimeWindow } from '../diagnose/downtime';
import {
  isWithinDailyWindow,
  istClock,
  istMinutesOfDay,
  nextIstTimeOfDay,
  nextSalaryWindow,
  parseTimeOfDay,
  scaleDelayMs,
  scheduleAfter,
} from './clock';
import { BanditTimingStrategy, armToHours, banditBucketKey, sampleBeta } from './bandit-strategy';
import { STATIC_DELAY_HOURS, StaticTimingStrategy, staticDelayHours } from './static-strategy';
import type { TimingContext } from './strategy';

const NOW = new Date('2026-02-10T12:00:00.000Z'); // 17:30 IST on the 10th

function context(overrides: Partial<TimingContext> = {}): TimingContext {
  return {
    rootCause: 'issuer_down',
    issuer: 'hdfc',
    method: 'card',
    attemptCount: 0,
    salaryWindowDays: [1, 2, 3],
    demoTimeScale: 1,
    downtimeWindow: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The central scaling helper
// ---------------------------------------------------------------------------

describe('scaleDelayMs — the one place delays are scaled', () => {
  it('divides by the demo time scale', () => {
    // 4 hours at 360× becomes 40 seconds, the example from the docs.
    expect(scaleDelayMs(4 * 60 * 60 * 1000, 360)).toBe(40_000);
  });

  it('is identity at scale 1', () => {
    expect(scaleDelayMs(7200_000, 1)).toBe(7200_000);
  });

  /** Fails CLOSED: a scale that cannot be trusted must not speed the system up. */
  it('falls back to real timing on a nonsensical scale', () => {
    for (const scale of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scaleDelayMs(3600_000, scale as number), String(scale)).toBe(3600_000);
    }
  });

  it('clamps a negative or NaN delay to zero rather than scheduling in the past', () => {
    expect(scaleDelayMs(-5000, 1)).toBe(0);
    expect(scaleDelayMs(Number.NaN, 1)).toBe(0);
  });

  it('scheduleAfter is the only way a future instant is produced', () => {
    expect(scheduleAfter(NOW, 3600_000, 1).toISOString()).toBe('2026-02-10T13:00:00.000Z');
    expect(scheduleAfter(NOW, 3600_000, 360).toISOString()).toBe('2026-02-10T12:00:10.000Z');
  });
});

describe('DEMO_TIME_SCALE compresses every strategy output', () => {
  it('the static strategy honours the scale', () => {
    const strategy = new StaticTimingStrategy();
    const real = strategy.schedule(context({ demoTimeScale: 1 }), NOW);
    const fast = strategy.schedule(context({ demoTimeScale: 360 }), NOW);

    const realDelay = real.scheduledFor.getTime() - NOW.getTime();
    const fastDelay = fast.scheduledFor.getTime() - NOW.getTime();

    expect(realDelay).toBeGreaterThan(0);
    expect(fastDelay).toBe(Math.round(realDelay / 360));
    // The NOMINAL delay is unchanged — the audit record still says "2h".
    expect(fast.nominalDelayHours).toBe(real.nominalDelayHours);
  });

  it('the salary window is compressed too', () => {
    const strategy = new StaticTimingStrategy();
    const c = { rootCause: 'insufficient_funds', attemptCount: 0 };
    const real = strategy.schedule(context({ ...c, demoTimeScale: 1 }), NOW);
    const fast = strategy.schedule(context({ ...c, demoTimeScale: 360 }), NOW);

    expect(real.basis).toBe('salary_window');
    expect(fast.scheduledFor.getTime() - NOW.getTime()).toBeLessThan(
      real.scheduledFor.getTime() - NOW.getTime(),
    );
  });

  it('a resolved downtime wait is compressed too', () => {
    const strategy = new StaticTimingStrategy();
    const window: DowntimeWindow = {
      id: 'w',
      issuer: 'hdfc',
      method: 'card',
      startedAt: new Date('2026-02-10T11:00:00.000Z'),
      resolvedAt: new Date('2026-02-10T20:00:00.000Z'),
      severity: 'high',
    };
    const real = strategy.schedule(context({ downtimeWindow: window, demoTimeScale: 1 }), NOW);
    const fast = strategy.schedule(context({ downtimeWindow: window, demoTimeScale: 360 }), NOW);

    expect(fast.scheduledFor.getTime() - NOW.getTime()).toBeLessThan(
      real.scheduledFor.getTime() - NOW.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// IST helpers
// ---------------------------------------------------------------------------

describe('IST helpers', () => {
  it('decomposes a UTC instant into IST', () => {
    const clock = istClock(new Date('2026-02-10T12:00:00.000Z'));
    expect(clock.hour).toBe(17);
    expect(clock.minute).toBe(30);
    expect(clock.day).toBe(10);
  });

  it('istMinutesOfDay handles the day boundary', () => {
    // 18:30 UTC = 00:00 IST the next day.
    expect(istMinutesOfDay(new Date('2026-02-10T18:30:00.000Z'))).toBe(0);
    // 15:29 UTC = 20:59 IST.
    expect(istMinutesOfDay(new Date('2026-02-10T15:29:00.000Z'))).toBe(20 * 60 + 59);
  });

  it('parseTimeOfDay accepts HH:MM and rejects everything else', () => {
    expect(parseTimeOfDay('21:00')).toBe(1260);
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('00:00')).toBe(0);
    for (const bad of ['', '9pm', '25:00', '21:60', '2100', null, undefined, '  ']) {
      expect(parseTimeOfDay(bad as string), String(bad)).toBeNull();
    }
  });

  /** Quiet hours wrap past midnight, so a naive comparison would invert the night. */
  it('isWithinDailyWindow handles a wrapping window', () => {
    const start = 21 * 60;
    const end = 9 * 60;
    expect(isWithinDailyWindow(21 * 60 + 1, start, end)).toBe(true);
    expect(isWithinDailyWindow(0, start, end)).toBe(true);
    expect(isWithinDailyWindow(3 * 60, start, end)).toBe(true);
    expect(isWithinDailyWindow(8 * 60 + 59, start, end)).toBe(true);
    expect(isWithinDailyWindow(9 * 60, start, end)).toBe(false);
    expect(isWithinDailyWindow(20 * 60 + 59, start, end)).toBe(false);
  });

  it('nextIstTimeOfDay rolls to tomorrow when the time has passed', () => {
    // 09:00 IST after 17:30 IST on the 10th → the 11th.
    expect(nextIstTimeOfDay(NOW, 9 * 60).toISOString()).toBe('2026-02-11T03:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The salary-cycle heuristic
// ---------------------------------------------------------------------------

describe('the salary-cycle heuristic', () => {
  it('finds the next window day this month', () => {
    // 10th → no window day left this month (1,2,3), so next month.
    const from = new Date('2026-02-10T12:00:00.000Z');
    const next = nextSalaryWindow(from, [1, 2, 3], 11);
    expect(next?.toISOString()).toBe('2026-03-01T05:30:00.000Z'); // 11:00 IST 1 Mar
  });

  it('picks a later day in the same month when one remains', () => {
    // 1st → the 2nd is still ahead.
    const from = new Date('2026-02-01T12:00:00.000Z');
    const next = nextSalaryWindow(from, [1, 2, 3], 11);
    expect(next?.toISOString()).toBe('2026-02-02T05:30:00.000Z');
  });

  it('rolls across a year boundary', () => {
    const from = new Date('2026-12-20T12:00:00.000Z');
    const next = nextSalaryWindow(from, [1, 2, 3], 11);
    expect(next?.getUTCFullYear()).toBe(2027);
    expect(next?.getUTCMonth()).toBe(0);
  });

  /** Fail closed: no usable window means the caller falls back to a plain delay. */
  it('returns null on a malformed window list', () => {
    for (const days of [[], [0], [99], [-1], [1.5]]) {
      expect(nextSalaryWindow(NOW, days, 11), JSON.stringify(days)).toBeNull();
    }
  });

  /**
   * The headline behaviour from POLICY_SPEC §4: "A failure on the 20th schedules to
   * the 1st rather than to +24h."
   */
  it('a failure late in the month schedules INTO the window, not +24h', () => {
    const strategy = new StaticTimingStrategy();
    const late = new Date('2026-02-20T12:00:00.000Z'); // 20th, 17:30 IST

    const decision = strategy.schedule(
      context({ rootCause: 'insufficient_funds', attemptCount: 0 }),
      late,
    );

    expect(decision.basis).toBe('salary_window');
    // 1 March, not 21 February.
    const scheduled = istClock(decision.scheduledFor);
    expect(scheduled.month).toBe(2);
    expect([1, 2, 3]).toContain(scheduled.day);
    expect(decision.reason).toMatch(/salary window/);
  });

  it('does NOT push a failure early in the month a month forward', () => {
    const strategy = new StaticTimingStrategy();
    // 1st: the plain +24h delay already lands inside/near the window.
    const early = new Date('2026-02-01T12:00:00.000Z');
    const decision = strategy.schedule(
      context({ rootCause: 'insufficient_funds', attemptCount: 0 }),
      early,
    );
    // Either the table or a nearby window day, but never a month out.
    expect(decision.scheduledFor.getTime() - early.getTime()).toBeLessThan(5 * 24 * 60 * 60 * 1000);
  });

  it('applies to a mandate balance shortfall too', () => {
    const strategy = new StaticTimingStrategy();
    const late = new Date('2026-02-20T12:00:00.000Z');
    const decision = strategy.schedule(
      context({ rootCause: 'mandate_insufficient_balance' }),
      late,
    );
    expect(decision.basis).toBe('salary_window');
  });

  it('falls back to the static table when the window list is unusable', () => {
    const strategy = new StaticTimingStrategy();
    const decision = strategy.schedule(
      context({ rootCause: 'insufficient_funds', salaryWindowDays: [] }),
      new Date('2026-02-20T12:00:00.000Z'),
    );
    expect(decision.basis).toBe('static_table');
  });
});

// ---------------------------------------------------------------------------
// The static delay table
// ---------------------------------------------------------------------------

describe('the static delay table matches POLICY_SPEC §4', () => {
  it('issuer_down is 2h', () => {
    expect(staticDelayHours('issuer_down', 0)).toBe(2);
  });

  it('gateway_timeout is 0 then 1h', () => {
    expect(staticDelayHours('gateway_timeout', 0)).toBe(0);
    expect(staticDelayHours('gateway_timeout', 1)).toBe(1);
  });

  it('otp_abandoned is 0 then 4h', () => {
    expect(staticDelayHours('otp_abandoned', 0)).toBe(0);
    expect(staticDelayHours('otp_abandoned', 1)).toBe(4);
  });

  it('issuer_declined is 24h', () => {
    expect(staticDelayHours('issuer_declined', 0)).toBe(24);
  });

  it('mandates use the 48h re-presentment convention', () => {
    expect(staticDelayHours('mandate_debit_failed', 0)).toBe(48);
    expect(staticDelayHours('mandate_insufficient_balance', 0)).toBe(48);
  });

  it('covers every cause in the table with a non-negative ladder', () => {
    for (const [cause, ladder] of Object.entries(STATIC_DELAY_HOURS)) {
      expect(ladder.length, cause).toBeGreaterThan(0);
      for (const hours of ladder) {
        expect(Number.isFinite(hours), cause).toBe(true);
        expect(hours, cause).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('clamps past the end of the ladder rather than returning undefined', () => {
    expect(staticDelayHours('issuer_down', 99)).toBe(4);
  });

  it('falls back for an unknown cause rather than throwing', () => {
    expect(staticDelayHours('no_such_cause', 0)).toBe(6);
  });

  it('an immediate action is marked as such', () => {
    const decision = new StaticTimingStrategy().schedule(
      context({ rootCause: 'gateway_timeout' }),
      NOW,
    );
    expect(decision.basis).toBe('immediate');
    expect(decision.scheduledFor.getTime()).toBe(NOW.getTime());
  });
});

// ---------------------------------------------------------------------------
// The bandit
// ---------------------------------------------------------------------------

describe('the bandit', () => {
  /** A deterministic RNG. Math.random() would make arm comparisons noise. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('builds the bucket key as issuer:method:root_cause', () => {
    expect(
      banditBucketKey({ issuer: 'HDFC', method: 'card', rootCause: 'insufficient_funds' }),
    ).toBe('hdfc:card:insufficient_funds');
  });

  it('keeps a case with no issuer or method in its own bucket', () => {
    expect(banditBucketKey({ issuer: null, method: null, rootCause: 'issuer_down' })).toBe(
      'unknown:unknown:issuer_down',
    );
  });

  it('parses arm labels and rejects malformed ones', () => {
    expect(armToHours('2h')).toBe(2);
    expect(armToHours('48h')).toBe(48);
    for (const bad of ['', '2', 'h', 'two hours', '-2h']) {
      expect(armToHours(bad), bad).toBeNull();
    }
  });

  it('sampleBeta stays in [0, 1] and is reproducible', () => {
    const a = seeded(1);
    const b = seeded(1);
    for (let i = 0; i < 200; i += 1) {
      const x = sampleBeta(3, 7, a);
      const y = sampleBeta(3, 7, b);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(x).toBe(y);
    }
  });

  it('sampleBeta recovers from degenerate parameters instead of returning NaN', () => {
    for (const [alpha, beta] of [[0, 0], [Number.NaN, 1], [-1, -1]] as const) {
      const value = sampleBeta(alpha, beta, seeded(9));
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  /** docs/DATABASE_DESIGN.md: an empty table degrades to the static table. */
  it('a COLD bucket falls back to static', () => {
    const strategy = new BanditTimingStrategy({
      arms: [],
      armHours: [2, 6, 18, 48],
      random: seeded(42),
    });
    const decision = strategy.schedule(context({ rootCause: 'issuer_down' }), NOW);

    expect(decision.basis).toBe('bandit_cold_fallback');
    expect(decision.nominalDelayHours).toBe(2);
    expect(decision.banditBucketKey).toBe('hdfc:card:issuer_down');
  });

  it('samples an arm for a warm bucket', () => {
    const bucketKey = 'hdfc:card:issuer_down';
    const strategy = new BanditTimingStrategy({
      arms: [
        { bucketKey, arm: '2h', alpha: 1, beta: 40 },
        { bucketKey, arm: '6h', alpha: 1, beta: 40 },
        // Overwhelmingly the best arm.
        { bucketKey, arm: '18h', alpha: 90, beta: 1 },
        { bucketKey, arm: '48h', alpha: 1, beta: 40 },
      ],
      armHours: [2, 6, 18, 48],
      random: seeded(42),
    });

    const decision = strategy.schedule(context({ rootCause: 'issuer_down' }), NOW);
    expect(decision.basis).toBe('bandit_sample');
    expect(decision.banditArm).toBe('18h');
    expect(decision.nominalDelayHours).toBe(18);
  });

  it('is reproducible for a given seed', () => {
    const bucketKey = 'hdfc:card:issuer_down';
    const arms = [
      { bucketKey, arm: '2h', alpha: 5, beta: 5 },
      { bucketKey, arm: '6h', alpha: 6, beta: 4 },
      { bucketKey, arm: '18h', alpha: 4, beta: 6 },
      { bucketKey, arm: '48h', alpha: 5, beta: 5 },
    ];

    const first = new BanditTimingStrategy({ arms, armHours: [2, 6, 18, 48], random: seeded(7) })
      .schedule(context(), NOW);
    const second = new BanditTimingStrategy({ arms, armHours: [2, 6, 18, 48], random: seeded(7) })
      .schedule(context(), NOW);

    expect(second.banditArm).toBe(first.banditArm);
    expect(second.scheduledFor.getTime()).toBe(first.scheduledFor.getTime());
  });

  it('falls back when the arm list from policy is empty', () => {
    const strategy = new BanditTimingStrategy({ arms: [], armHours: [], random: seeded(1) });
    expect(strategy.schedule(context(), NOW).basis).toBe('bandit_cold_fallback');
  });

  /** Exploration must not override a known outage — that is policy, not a guess. */
  it('does not override downtime-aware timing', () => {
    const window: DowntimeWindow = {
      id: 'w',
      issuer: 'hdfc',
      method: 'card',
      startedAt: new Date('2026-02-10T11:00:00.000Z'),
      resolvedAt: null,
      severity: 'high',
    };
    const strategy = new BanditTimingStrategy({
      arms: [{ bucketKey: 'hdfc:card:issuer_down', arm: '48h', alpha: 99, beta: 1 }],
      armHours: [2, 6, 18, 48],
      random: seeded(3),
    });

    const decision = strategy.schedule(context({ downtimeWindow: window }), NOW);
    expect(decision.basis).toBe('downtime_recheck');
    expect(decision.recheckOnly).toBe(true);
  });
});
