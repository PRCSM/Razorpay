/**
 * Defensive readers for provider payloads.
 *
 * Every one of these takes `unknown` and returns either a usable value or null.
 * None of them throw. That is the whole point: TASK 2 requires that an unknown
 * payload shape produces a case full of nulls rather than an exception, so a
 * delivery we did not anticipate becomes a diagnosable case instead of a crash
 * loop in the ingest worker.
 *
 * Pure. No I/O, no clock.
 */

/** Narrow `unknown` to a plain object. Arrays and null are rejected. */
export function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read a property from a possibly-absent object. */
export function readProp(source: unknown, key: string): unknown {
  const object = readObject(source);
  if (!object) return undefined;
  return object[key];
}

/**
 * Walk a dotted path, e.g. `payload.payment.entity`.
 * Returns undefined the moment the path stops resolving.
 */
export function readPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    const object = readObject(current);
    if (!object) return undefined;
    current = object[key];
  }
  return current;
}

/** A non-empty trimmed string, or null. */
export function readString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  // Providers occasionally send numeric ids. Accept them rather than lose them.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A non-negative safe integer, or null.
 *
 * Accepts a numeric string, because JSON payloads are inconsistent about whether
 * amounts are quoted. Rejects fractional values outright: a fractional "paise"
 * amount means the value is really rupees, and silently rounding it would corrupt
 * money. Callers treat null as "unparseable" and record it.
 */
export function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Unix seconds to a Date, or null. */
export function readUnixSeconds(value: unknown): Date | null {
  const seconds = readNonNegativeInteger(value);
  if (seconds === null) return null;
  return new Date(seconds * 1000);
}

/** First non-null result of reading `keys` from `source`. */
export function readFirstString(source: unknown, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = readString(readProp(source, key));
    if (found !== null) return found;
  }
  return null;
}
