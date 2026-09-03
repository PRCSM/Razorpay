/**
 * Deterministic time helpers, all in IST.
 *
 * The salary-squeeze cluster is defined as "the 18th–28th of the month", and a
 * month boundary only means something in a timezone. policy.yaml uses
 * `Asia/Kolkata`, so the generator does too — computed with an explicit fixed
 * offset rather than `toLocaleString`, because the output must be byte-identical
 * regardless of the machine's local timezone.
 *
 * IST is UTC+05:30 year round; India observes no daylight saving, so a fixed
 * offset is exact rather than an approximation.
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface IstDateParts {
  readonly year: number;
  /** 0-indexed, like Date. */
  readonly month: number;
  /** Day of month, 1-31. */
  readonly day: number;
}

/** The IST calendar date a UTC instant falls on. */
export function istParts(instant: Date): IstDateParts {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** Day of month in IST. */
export function istDayOfMonth(instant: Date): number {
  return istParts(instant).day;
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

/** Every IST calendar day in `[start, end]`, inclusive. */
export function istAllDays(start: Date, end: Date): readonly IstDateParts[] {
  const days: IstDateParts[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Step a day at a time from the IST midnight of `start`.
  const first = istParts(start);
  let cursor = utcFromIst(first.year, first.month, first.day, 0, 0).getTime();
  const endMs = end.getTime();

  while (cursor <= endMs) {
    days.push(istParts(new Date(cursor)));
    cursor += oneDayMs;
  }
  return days;
}

/**
 * IST days in `[start, end]` whose day-of-month falls inside `[dayMin, dayMax]`.
 * Used to place insufficient_funds cases in the salary window.
 */
export function istDaysInRange(
  start: Date,
  end: Date,
  dayMin: number,
  dayMax: number,
): readonly IstDateParts[] {
  return istAllDays(start, end).filter((d) => d.day >= dayMin && d.day <= dayMax);
}

/** IST days in `[start, end]` OUTSIDE `[dayMin, dayMax]` — the cluster's tail. */
export function istDaysOutsideRange(
  start: Date,
  end: Date,
  dayMin: number,
  dayMax: number,
): readonly IstDateParts[] {
  return istAllDays(start, end).filter((d) => d.day < dayMin || d.day > dayMax);
}
