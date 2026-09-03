import { describe, expect, it } from 'vitest';
import { deriveProviderEventId, parseWebhookEnvelope } from './envelope';
import {
  isCaseOpeningEvent,
  isRecoverySignalEvent,
  isSubscribedEvent,
  SUBSCRIBED_EVENT_TYPES,
} from './events';

describe('parseWebhookEnvelope', () => {
  it('accepts a well-formed Razorpay envelope', () => {
    const body = JSON.stringify({
      entity: 'event',
      account_id: 'acc_TEST',
      event: 'payment.failed',
      contains: ['payment'],
      payload: { payment: { entity: { id: 'pay_1', amount: 25000 } } },
      created_at: 1_770_000_000,
    });

    const result = parseWebhookEnvelope(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.event).toBe('payment.failed');
      expect(result.envelope.payload).toHaveProperty('payment');
    }
  });

  it('rejects a body that is not JSON', () => {
    const result = parseWebhookEnvelope('not json at all');
    expect(result).toEqual({ ok: false, reason: 'body is not valid JSON' });
  });

  it('rejects an envelope with no event type', () => {
    const result = parseWebhookEnvelope(JSON.stringify({ payload: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('event');
  });

  it('rejects an envelope with no payload', () => {
    const result = parseWebhookEnvelope(JSON.stringify({ event: 'payment.failed' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('payload');
  });

  /**
   * Deliberately permissive: docs/DATABASE_DESIGN.md requires storing what the
   * provider sent. A schema tight enough to reject an unfamiliar entity would
   * drop deliveries the normalizer is required to handle.
   */
  it('accepts an unfamiliar payload shape rather than dropping the delivery', () => {
    const result = parseWebhookEnvelope(
      JSON.stringify({ event: 'payment.failed', payload: { something_new: { nested: 1 } } }),
    );
    expect(result.ok).toBe(true);
  });

  it('preserves unknown top-level fields', () => {
    const result = parseWebhookEnvelope(
      JSON.stringify({ event: 'order.paid', payload: {}, future_field: 'keep me' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.envelope as Record<string, unknown>)['future_field']).toBe('keep me');
    }
  });

  it('rejects a JSON array', () => {
    expect(parseWebhookEnvelope('[]').ok).toBe(false);
  });
});

describe('deriveProviderEventId', () => {
  const body = JSON.stringify({ event: 'payment.failed', payload: {} });

  it('prefers the x-razorpay-event-id header', () => {
    expect(deriveProviderEventId({ eventIdHeader: 'evt_abc123', rawBody: body })).toBe('evt_abc123');
  });

  it('trims the header', () => {
    expect(deriveProviderEventId({ eventIdHeader: '  evt_abc123 ', rawBody: body })).toBe(
      'evt_abc123',
    );
  });

  it('falls back to a deterministic digest when the header is absent', () => {
    const a = deriveProviderEventId({ eventIdHeader: null, rawBody: body });
    const b = deriveProviderEventId({ eventIdHeader: undefined, rawBody: body });
    expect(a).toBe(b);
    expect(a).toMatch(/^derived_[0-9a-f]{40}$/);
  });

  /** This is what makes a retried delivery collapse to one row. */
  it('gives the same id for the same body and different ids for different bodies', () => {
    const same = deriveProviderEventId({ eventIdHeader: null, rawBody: body });
    const other = deriveProviderEventId({
      eventIdHeader: null,
      rawBody: JSON.stringify({ event: 'order.paid', payload: {} }),
    });
    expect(same).toBe(deriveProviderEventId({ eventIdHeader: null, rawBody: body }));
    expect(same).not.toBe(other);
  });

  it('treats an empty header as absent', () => {
    const derived = deriveProviderEventId({ eventIdHeader: '   ', rawBody: body });
    expect(derived).toMatch(/^derived_/);
  });
});

describe('event vocabulary', () => {
  it('subscribes to exactly the nine registered events', () => {
    expect([...SUBSCRIBED_EVENT_TYPES]).toEqual([
      'payment.failed',
      'payment.captured',
      'order.paid',
      'payment_link.paid',
      'subscription.halted',
      'subscription.pending',
      'subscription.charged',
      'invoice.paid',
      'invoice.expired',
    ]);
    expect(SUBSCRIBED_EVENT_TYPES).toHaveLength(9);
  });

  it('classifies case-opening events', () => {
    for (const event of [
      'payment.failed',
      'subscription.halted',
      'subscription.pending',
      'invoice.expired',
      'checkout.abandoned',
    ]) {
      expect(isCaseOpeningEvent(event)).toBe(true);
      expect(isRecoverySignalEvent(event)).toBe(false);
    }
  });

  it('classifies recovery-signal events', () => {
    for (const event of [
      'payment.captured',
      'order.paid',
      'payment_link.paid',
      'subscription.charged',
      'invoice.paid',
    ]) {
      expect(isRecoverySignalEvent(event)).toBe(true);
      expect(isCaseOpeningEvent(event)).toBe(false);
    }
  });

  it('no event is both case-opening and a recovery signal', () => {
    for (const event of SUBSCRIBED_EVENT_TYPES) {
      expect(isCaseOpeningEvent(event) && isRecoverySignalEvent(event)).toBe(false);
    }
  });

  it('rejects an unknown event type', () => {
    expect(isSubscribedEvent('payment.exploded')).toBe(false);
    expect(isCaseOpeningEvent('payment.exploded')).toBe(false);
  });
});
