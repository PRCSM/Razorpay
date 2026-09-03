import { describe, expect, it } from 'vitest';
import {
  findActiveDowntime,
  windowAppliesTo,
  windowCoversInstant,
  type DowntimeWindow,
} from './downtime';
import { normalizeDowntimeEvent } from '../normalize/downtime';

/**
 * TASK 8 names the exact cases: inside window, outside window, wrong issuer,
 * wrong method, unresolved window. All five are here, plus the live-shaped payload.
 */

const T = (iso: string): Date => new Date(iso);

function window(overrides: Partial<DowntimeWindow> = {}): DowntimeWindow {
  return {
    id: 'w1',
    issuer: 'hdfc',
    method: 'card',
    startedAt: T('2026-02-10T10:00:00.000Z'),
    resolvedAt: T('2026-02-10T11:00:00.000Z'),
    severity: 'high',
    ...overrides,
  };
}

describe('windowCoversInstant', () => {
  it('covers an instant inside the window', () => {
    expect(windowCoversInstant(window(), T('2026-02-10T10:30:00.000Z'))).toBe(true);
  });

  it('is inclusive at both boundaries', () => {
    expect(windowCoversInstant(window(), T('2026-02-10T10:00:00.000Z'))).toBe(true);
    expect(windowCoversInstant(window(), T('2026-02-10T11:00:00.000Z'))).toBe(true);
  });

  it('excludes an instant before it started', () => {
    expect(windowCoversInstant(window(), T('2026-02-10T09:59:59.000Z'))).toBe(false);
  });

  it('excludes an instant after it resolved', () => {
    expect(windowCoversInstant(window(), T('2026-02-10T11:00:01.000Z'))).toBe(false);
  });

  it('an UNRESOLVED window extends indefinitely forward', () => {
    const open = window({ resolvedAt: null });
    expect(windowCoversInstant(open, T('2026-02-10T10:30:00.000Z'))).toBe(true);
    expect(windowCoversInstant(open, T('2027-01-01T00:00:00.000Z'))).toBe(true);
    // But still not before it began.
    expect(windowCoversInstant(open, T('2026-02-10T09:00:00.000Z'))).toBe(false);
  });
});

describe('windowAppliesTo', () => {
  const at = T('2026-02-10T10:30:00.000Z');

  it('matches the same issuer and method', () => {
    expect(windowAppliesTo(window(), { issuer: 'hdfc', method: 'card', at })).toBe(true);
  });

  it('rejects the WRONG ISSUER', () => {
    expect(windowAppliesTo(window(), { issuer: 'icici', method: 'card', at })).toBe(false);
  });

  it('rejects the WRONG METHOD', () => {
    expect(windowAppliesTo(window(), { issuer: 'hdfc', method: 'upi', at })).toBe(false);
  });

  it('is case-insensitive about the issuer', () => {
    expect(windowAppliesTo(window({ issuer: 'HDFC' }), { issuer: 'hdfc', method: 'card', at })).toBe(
      true,
    );
    expect(windowAppliesTo(window(), { issuer: '  HDFC  ', method: 'card', at })).toBe(true);
  });

  it('a null issuer on the window is a platform-wide wildcard', () => {
    const platformWide = window({ issuer: null });
    expect(windowAppliesTo(platformWide, { issuer: 'anybank', method: 'card', at })).toBe(true);
  });

  it('a null method on the window matches every rail', () => {
    const allRails = window({ method: null });
    expect(windowAppliesTo(allRails, { issuer: 'hdfc', method: 'upi', at })).toBe(true);
    expect(windowAppliesTo(allRails, { issuer: 'hdfc', method: 'netbanking', at })).toBe(true);
  });

  it('a case with no issuer cannot match an issuer-scoped window', () => {
    expect(windowAppliesTo(window(), { issuer: null, method: 'card', at })).toBe(false);
  });
});

describe('findActiveDowntime', () => {
  const at = T('2026-02-10T10:30:00.000Z');

  it('finds a covering window', () => {
    const found = findActiveDowntime({ issuer: 'hdfc', method: 'card', at }, [window()]);
    expect(found?.id).toBe('w1');
  });

  it('returns null when nothing covers the instant', () => {
    const found = findActiveDowntime(
      { issuer: 'hdfc', method: 'card', at: T('2026-02-11T00:00:00.000Z') },
      [window()],
    );
    expect(found).toBeNull();
  });

  it('returns null for an empty window list — the synthetic lane', () => {
    expect(findActiveDowntime({ issuer: 'hdfc', method: 'card', at }, [])).toBeNull();
  });

  it('prefers the more specific window over a platform-wide one', () => {
    const specific = window({ id: 'specific', issuer: 'hdfc', method: 'card' });
    const wide = window({ id: 'wide', issuer: null, method: null });
    const found = findActiveDowntime({ issuer: 'hdfc', method: 'card', at }, [wide, specific]);
    expect(found?.id).toBe('specific');
  });

  it('breaks a specificity tie on the later start', () => {
    const older = window({ id: 'older', startedAt: T('2026-02-10T09:00:00.000Z') });
    const newer = window({ id: 'newer', startedAt: T('2026-02-10T10:15:00.000Z') });
    const found = findActiveDowntime({ issuer: 'hdfc', method: 'card', at }, [older, newer]);
    expect(found?.id).toBe('newer');
  });
});

describe('normalizeDowntimeEvent — live-shaped payloads', () => {
  const receivedAt = T('2026-02-10T10:05:00.000Z');

  it('normalizes payment.downtime.started', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.started',
      receivedAt,
      payload: {
        entity: 'event',
        event: 'payment.downtime.started',
        contains: ['payment.downtime'],
        payload: {
          payment: {
            downtime: {
              entity: {
                id: 'down_TEST123',
                entity: 'payment.downtime',
                method: 'upi',
                begin: Math.floor(T('2026-02-10T10:00:00.000Z').getTime() / 1000),
                end: null,
                status: 'started',
                scheduled: false,
                severity: 'high',
                instrument: { vpa_handle: 'okhdfcbank' },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.providerDowntimeId).toBe('down_TEST123');
    expect(result.draft.method).toBe('upi');
    expect(result.draft.issuer).toBe('okhdfcbank');
    expect(result.draft.startedAt).toEqual(T('2026-02-10T10:00:00.000Z'));
    expect(result.draft.resolvedAt).toBeNull();
    expect(result.draft.severity).toBe('high');
    expect(result.draft.scheduled).toBe(false);
  });

  it('reads a card outage issuer from instrument.bank', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.started',
      receivedAt,
      payload: {
        payload: {
          payment: {
            downtime: {
              entity: { id: 'd2', method: 'card', instrument: { bank: 'HDFC' }, status: 'started' },
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.issuer).toBe('hdfc');
      expect(result.draft.method).toBe('card');
    }
  });

  it('closes the window on payment.downtime.resolved', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.resolved',
      receivedAt,
      payload: {
        payload: {
          payment: {
            downtime: {
              entity: {
                id: 'd3',
                method: 'card',
                begin: Math.floor(T('2026-02-10T09:00:00.000Z').getTime() / 1000),
                end: Math.floor(T('2026-02-10T10:00:00.000Z').getTime() / 1000),
                status: 'resolved',
                instrument: { bank: 'SBI' },
              },
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.resolvedAt).toEqual(T('2026-02-10T10:00:00.000Z'));
  });

  /** A resolution with no end would otherwise leave the window open forever. */
  it('falls back to the delivery time when a resolved event has no end', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.resolved',
      receivedAt,
      payload: {
        payload: { payment: { downtime: { entity: { id: 'd4', status: 'resolved' } } } },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.resolvedAt).toEqual(receivedAt);
      expect(result.warnings.join(' ')).toMatch(/end timestamp/);
    }
  });

  it('refuses a payload with no id — there would be no upsert key', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.started',
      receivedAt,
      payload: { payload: { payment: { downtime: { entity: { method: 'upi' } } } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no id/);
  });

  it('treats a missing issuer as a platform-wide outage, with a warning', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.downtime.started',
      receivedAt,
      payload: { payload: { payment: { downtime: { entity: { id: 'd5', method: 'card' } } } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.issuer).toBeNull();
      expect(result.warnings.join(' ')).toMatch(/platform-wide/);
    }
  });

  it('rejects a non-downtime event', () => {
    const result = normalizeDowntimeEvent({
      eventType: 'payment.failed',
      receivedAt,
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it('never throws on a malformed payload', () => {
    for (const payload of [null, undefined, 'text', 42, [], {}, { payload: null }]) {
      expect(() =>
        normalizeDowntimeEvent({
          eventType: 'payment.downtime.started',
          receivedAt,
          payload,
        }),
      ).not.toThrow();
    }
  });
});
