/**
 * Time arithmetic for scheduling. PURE — `now` is always a parameter.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PLACE DELAYS ARE SCALED
 *
 * `DEMO_TIME_SCALE` compresses every scheduling delay for the demo video: at 360,
 * a 4-hour wait becomes 40 seconds. docs/CLAUDE_CONTEXT.md has warned since Run 1
 * that "one central helper; no call site computes a delay independently.
 * Retrofitting means touching every call site."
 *
 * `scaleDelayMs` is that helper. Nothing else in the codebase divides by the
 * scale, and `scheduleAfter` is the only way a future instant is produced. A test
 * asserts that a scale of 360 compresses every strategy's output, which is what
 * makes the guarantee checkable rather than aspirational.
 * ---------------------------------------------------------------------------
 */

/** IST is UTC+05:30 year round — India observes no daylight saving. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Divide a delay by the demo time scale.
 *
 * Fails CLOSED on a nonsensical scale: an undefined, zero, negative, or NaN scale
 * falls back to 1 (real timing) rather than to a division that yields Infinity or
 * NaN and schedules an action at an invalid instant. A scale that cannot be
 * trusted must slow the system down, never speed it up.
 */
export function scaleDelayMs(delayMs: number, demoTimeScale: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) return 0;

  const scale =
    Number.isFinite(demoTimeScale) && demoTimeScale >= 1 ? Math.floor(demoTimeScale) : 1;

  return Math.round(delayMs / scale);
}

/** `now` plus a scaled delay. The only way a scheduled instant is created. */
export function scheduleAfter(now: Date, delayMs: number, demoTimeScale: number): Date {
  return new Date(now.getTime() + scaleDelayMs(delayMs, demoTimeScale));
}

export function hoursToMs(hours: number): number {
  return Number.isFinite(hours) ? hours * HOUR_MS : 0;
}

// ---------------------------------------------------------------------------
// IST calendar helpers
// ---------------------------------------------------------------------------

export interface IstClock {
  readonly year: number;
  /** 0-indexed, like Date. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

/** Decompose a UTC instant into IST wall-clock parts. */
export function istClock(instant: Date): IstClock {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Build a UTC instant from an IST wall-clock time. */
export function utcFromIst(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, 0, 0) - IST_OFFSET_MS);
}

/** Minutes since IST midnight. Used by the quiet-hours gate. */
export function istMinutesOfDay(instant: Date): number {
  const clock = istClock(instant);
  return clock.hour * 60 + clock.minute;
}

/**
 * Parse `"HH:MM"` into minutes since midnight.
 *
 * Returns null on anything malformed. Callers must treat null as a REASON TO
 * BLOCK, never as "no restriction" — an unparseable quiet-hours boundary that
 * defaulted to "allowed" is precisely the fail-open bug this run exists to avoid.
 */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Is `instant` inside a daily window that may wrap past midnight?
 * Quiet hours are 21:00–09:00, so the window wraps and a naive `start <= t <= end`
 * comparison would be inverted for the entire night.
 */
export function isWithinDailyWindow(
  minutesOfDay: number,
  startMinutes: number,
  endMinutes: number,
): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) {
    return minutesOfDay >= startMinutes && minutesOfDay < endMinutes;
  }
  // Wrapping window, e.g. 21:00 → 09:00.
  return minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
}

/**
 * The next IST instant at `targetMinutes`, at or after `from`.
 * Used to reschedule an outreach action to the moment quiet hours end.
 */
export function nextIstTimeOfDay(from: Date, targetMinutes: number): Date {
  const clock = istClock(from);
  const hour = Math.floor(targetMinutes / 60);
  const minute = targetMinutes % 60;

  const today = utcFromIst(clock.year, clock.month, clock.day, hour, minute);
  if (today.getTime() > from.getTime()) return today;

  // Already past it today: the same wall-clock time tomorrow.
  const tomorrow = new Date(from.getTime() + DAY_MS);
  const t = istClock(tomorrow);
  return utcFromIst(t.year, t.month, t.day, hour, minute);
}

/** Days in an IST calendar month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The next salary window, per the POLICY_SPEC §4 heuristic.
 *
 * "The 1st–3rd and the last working day of the month carry materially higher
 * balances in the Indian retail market. A failure on the 20th schedules to the 1st
 * rather than to +24h."
 *
 * `windowDays` comes from policy.yaml `timing.salary_window_days` — never
 * hardcoded. Returns the next instant falling on one of those days, at
 * `preferredHour` IST, strictly after `from`.
 */
export function nextSalaryWindow(
  from: Date,
  windowDays: readonly number[],
  preferredHour: number,
): Date | null {
  const valid = windowDays
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 28)
    .slice()
    .sort((a, b) => a - b);

  // Fail closed: with no usable window the caller must fall back to a plain
  // delay rather than schedule at an invented date.
  if (valid.length === 0) return null;

  const clock = istClock(from);

  // A window day still ahead of us this month.
  for (const day of valid) {
    if (day > clock.day) {
      return utcFromIst(clock.year, clock.month, day, preferredHour, 0);
    }
  }

  // Otherwise the first window day of next month.
  const firstDay = valid[0];
  if (firstDay === undefined) return null;
  const nextMonth = clock.month === 11 ? 0 : clock.month + 1;
  const nextYear = clock.month === 11 ? clock.year + 1 : clock.year;
  return utcFromIst(nextYear, nextMonth, firstDay, preferredHour, 0);
}
