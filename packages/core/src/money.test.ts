import { describe, expect, it } from 'vitest';
import {
  addPaise,
  formatPaiseINR,
  isPaise,
  MoneyError,
  paise,
  paiseFromBigInt,
  paiseToBigInt,
  rupeesToPaise,
  scalePaise,
  subPaise,
  sumPaise,
} from './money';

/**
 * Money is the one place a silent bug turns into a wrong number in RESULTS.md,
 * so the rejection paths matter more than the happy path here.
 */
describe('paise', () => {
  it('accepts non-negative integers', () => {
    expect(paise(0)).toBe(0);
    expect(paise(2_500_000)).toBe(2_500_000);
  });

  it('rejects a fractional value, because that means rupees leaked in', () => {
    expect(() => paise(12.5)).toThrow(MoneyError);
    expect(() => paise(0.01)).toThrow(/integer paise/);
  });

  it('rejects negatives and NaN', () => {
    expect(() => paise(-1)).toThrow(MoneyError);
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
  });

  it('rejects values beyond the safe integer range', () => {
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('isPaise', () => {
  it('discriminates valid paise from everything else', () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise(0)).toBe(true);
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise(-1)).toBe(false);
    expect(isPaise('100')).toBe(false);
    expect(isPaise(null)).toBe(false);
  });
});

describe('bigint boundary', () => {
  it('round-trips through the database representation', () => {
    const value = paise(2_500_000);
    expect(paiseFromBigInt(paiseToBigInt(value))).toBe(value);
  });

  it('rejects a negative bigint', () => {
    expect(() => paiseFromBigInt(-5n)).toThrow(MoneyError);
  });

  it('rejects a bigint above the safe integer range', () => {
    expect(() => paiseFromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 10n)).toThrow(MoneyError);
  });
});

describe('rupeesToPaise', () => {
  it('converts rupees to paise', () => {
    expect(rupeesToPaise(1)).toBe(100);
    expect(rupeesToPaise(25_000)).toBe(2_500_000);
  });

  it('rounds to the nearest whole paisa rather than producing a float', () => {
    expect(rupeesToPaise(10.005)).toBe(1001);
    expect(rupeesToPaise(0.014)).toBe(1);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, and sums while staying integral', () => {
    expect(addPaise(paise(100), paise(250))).toBe(350);
    expect(subPaise(paise(500), paise(200))).toBe(300);
    expect(sumPaise([paise(1), paise(2), paise(3)])).toBe(6);
    expect(sumPaise([])).toBe(0);
  });

  it('refuses a subtraction that would go negative', () => {
    expect(() => subPaise(paise(100), paise(250))).toThrow(MoneyError);
  });

  it('scales by a probability and rounds to a whole paisa', () => {
    expect(scalePaise(paise(1000), 0.5)).toBe(500);
    expect(scalePaise(paise(1001), 0.5)).toBe(501);
    expect(() => scalePaise(paise(100), -0.5)).toThrow(MoneyError);
  });
});

describe('formatPaiseINR', () => {
  it('renders paise as rupees with Indian digit grouping', () => {
    expect(formatPaiseINR(paise(2_500_000))).toBe('₹25,000.00');
    expect(formatPaiseINR(paise(1))).toBe('₹0.01');
    expect(formatPaiseINR(paise(0))).toBe('₹0.00');
    expect(formatPaiseINR(paise(123_456_789))).toBe('₹12,34,567.89');
  });
});
