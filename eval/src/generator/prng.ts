/**
 * Seeded PRNG.
 *
 * docs/EVAL_METHODOLOGY.md: "Seeded PRNG. `pnpm eval:seed 500 --seed 42`
 * reproduces the identical dataset. Without this, arm comparisons are noise."
 *
 * mulberry32 — 32-bit state, uniform output, and identical results on every
 * platform and Node version. `Math.random()` is never used anywhere in the
 * generator; a single unseeded call would silently destroy reproducibility and
 * nothing would fail loudly to tell you.
 */

/** FNV-1a, so a string seed maps deterministically onto 32 bits. */
export function hashSeed(seed: string | number): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    // Mix the integer so adjacent seeds (41, 42, 43) give unrelated streams.
    let h = (seed | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A weighted choice: the value plus its relative share. */
export interface Weighted<T> {
  readonly value: T;
  /** Relative weight. Shares need not sum to 1 — they are normalised. */
  readonly weight: number;
}

/**
 * Deterministic random source.
 *
 * Every draw advances one shared stream, so the ORDER of calls is part of the
 * contract: reordering draws changes the dataset even with the same seed. Any
 * change to generation order is a dataset change and must be treated as one.
 */
export class Rng {
  private state: number;

  constructor(seed: string | number) {
    this.state = hashSeed(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: max (${max}) < min (${min})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    const item = items[Math.floor(this.next() * items.length)];
    // Index is in range by construction; the guard satisfies noUncheckedIndexedAccess.
    if (item === undefined) throw new Error('Rng.pick: index out of range');
    return item;
  }

  /** Weighted choice. Weights are normalised, so they may be percentages. */
  weighted<T>(entries: readonly Weighted<T>[]): T {
    if (entries.length === 0) throw new Error('Rng.weighted: empty distribution');

    let total = 0;
    for (const entry of entries) {
      if (entry.weight < 0) throw new Error('Rng.weighted: negative weight');
      total += entry.weight;
    }
    if (total <= 0) throw new Error('Rng.weighted: weights sum to zero');

    let threshold = this.next() * total;
    for (const entry of entries) {
      threshold -= entry.weight;
      if (threshold < 0) return entry.value;
    }
    // Floating-point tail: fall back to the last entry.
    const last = entries[entries.length - 1];
    if (last === undefined) throw new Error('Rng.weighted: unreachable');
    return last.value;
  }

  /** In-place Fisher-Yates. Deterministic for a given seed and call order. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const a = items[i];
      const b = items[j];
      if (a === undefined || b === undefined) continue;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /**
   * Integer sampled from a log-uniform range, so small amounts are common and
   * large ones are rare. Realistic for payment values, and it avoids a uniform
   * spread that would put implausible weight on very large sums.
   */
  logUniformInt(min: number, max: number): number {
    if (min <= 0 || max < min) throw new Error(`Rng.logUniformInt: bad range ${min}..${max}`);
    const value = Math.exp(this.float(Math.log(min), Math.log(max + 1)));
    return Math.min(max, Math.max(min, Math.floor(value)));
  }
}
