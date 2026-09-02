/**
 * Money. Integer paise, always.
 *
 * docs/INSTRUCTIONS.md hard rule 5: "Money is integer paise. Never floats.
 * Never a `number` that might be rupees."
 *
 * The `Paise` brand exists so the type system can tell the difference between
 * "a number of paise" and "some other number". A plain `number` parameter
 * accepts a rupee value by accident; `Paise` does not.
 *
 * Database columns are `bigint`. Postgres bigint exceeds JS safe-integer range,
 * so values crossing the DB boundary are handled as `bigint` there and narrowed
 * here only after a range check.
 */

declare const paiseBrand: unique symbol;

/** A non-negative integer count of paise. 100 paise = ₹1. */
export type Paise = number & { readonly [paiseBrand]: 'paise' };

export const PAISE_PER_RUPEE = 100;

/** Largest value we accept. Well inside Number.MAX_SAFE_INTEGER. */
export const MAX_PAISE = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** True when `value` is a safe, non-negative integer count of paise. */
export function isPaise(value: unknown): value is Paise {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PAISE
  );
}

/**
 * Assert a number is valid paise and brand it.
 * Throws rather than returning a result object: a float in a money path is a
 * programming defect, not a domain outcome.
 */
export function paise(value: number): Paise {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new MoneyError(`Money must be a number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Money must be integer paise, got ${value}. A fractional value here means rupees leaked into a paise field.`,
    );
  }
  if (value < 0) {
    throw new MoneyError(`Money must be non-negative, got ${value}`);
  }
  if (value > MAX_PAISE) {
    throw new MoneyError(`Money ${value} exceeds the safe integer range`);
  }
  return value as Paise;
}

/** Narrow a Postgres `bigint` to `Paise`, range-checked. */
export function paiseFromBigInt(value: bigint): Paise {
  if (value < 0n) {
    throw new MoneyError(`Money must be non-negative, got ${value}n`);
  }
  if (value > BigInt(MAX_PAISE)) {
    throw new MoneyError(`Money ${value}n exceeds JavaScript's safe integer range`);
  }
  return Number(value) as Paise;
}

/** Widen `Paise` for a `bigint` database column. */
export function paiseToBigInt(value: Paise): bigint {
  return BigInt(value);
}

/** Convert whole or fractional rupees to paise, rounding half-up to the nearest paisa. */
export function rupeesToPaise(rupees: number): Paise {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new MoneyError(`Rupees must be a finite number, got ${String(rupees)}`);
  }
  return paise(Math.round(rupees * PAISE_PER_RUPEE));
}

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subPaise(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function sumPaise(values: readonly Paise[]): Paise {
  return paise(values.reduce<number>((total, v) => total + v, 0));
}

/**
 * Multiply paise by a ratio (e.g. an expected-recovery probability) and round
 * to a whole paisa. Used for expected-value maths, never for a charged amount.
 */
export function scalePaise(value: Paise, ratio: number): Paise {
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new MoneyError(`Ratio must be a non-negative finite number, got ${String(ratio)}`);
  }
  return paise(Math.round(value * ratio));
}

/** Render paise for display: `250000` → `"₹2,500.00"`. Presentation only. */
export function formatPaiseINR(value: Paise): string {
  const rupees = Math.floor(value / PAISE_PER_RUPEE);
  const remainder = value % PAISE_PER_RUPEE;
  const grouped = rupees.toLocaleString('en-IN');
  return `₹${grouped}.${remainder.toString().padStart(2, '0')}`;
}
