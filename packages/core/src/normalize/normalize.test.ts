import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './index';

/**
 * Four sources, one shape. The important assertions here are the malformed ones:
 * TASK 2 requires that an unrecognised payload produces a null-filled case rather
 * than throwing, because a throw in the normalizer becomes a crash loop in the
 * ingest worker and stalls every event queued behind it.
 */
const RECEIVED_AT = new Date('2026-02-14T10:30:00.000Z');

function unwrap(result: ReturnType<typeof normalizeEvent>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result;
}

describe('normalize — payment.failed', () => {
  const payload = {
    payment: {
      entity: {
        id: 'pay_TEST123',
        amount: 250_000,
        currency: 'INR',
        method: 'card',
        bank: 'HDFC',
        customer_id: 'cust_TEST',
        error_code: 'BAD_REQUEST_ERROR',
        error_source: 'bank',
        error_step: 'payment_authorization',
        error_reason: 'insufficient_funds',
      },
    },
  };

  it('maps a card failure onto a payment case', () => {
    const { draft, warnings } = unwrap(
      normalizeEvent({ eventType: 'payment.failed', payload, receivedAt: RECEIVED_AT }),
    );

    expect(draft.source).toBe('payment');
    expect(draft.externalRef).toBe('pay_TEST123');
    expect(draft.amountPaise).toBe(250_000);
    expect(draft.currency).toBe('INR');
    expect(draft.customerRef).toBe('cust_TEST');
    expect(draft.method).toBe('card');
    expect(draft.issuer).toBe('hdfc');
    expect(draft.errorCode).toBe('BAD_REQUEST_ERROR');
    expect(draft.errorSource).toBe('bank');
    expect(draft.errorStep).toBe('payment_authorization');
    expect(draft.errorReason).toBe('insufficient_funds');
    expect(draft.openedAt).toEqual(RECEIVED_AT);
    expect(warnings).toEqual([]);
  });

  it('treats the amount as paise with no conversion', () => {
    // Razorpay already sends paise. Multiplying would inflate every number.
    const { draft } = unwrap(
      normalizeEvent({ eventType: 'payment.failed', payload, receivedAt: RECEIVED_AT }),
    );
    expect(draft.amountPaise).toBe(250_000);
    expect(Number.isInteger(draft.amountPaise)).toBe(true);
  });

  it('derives the issuer from a UPI handle', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: {
          payment: { entity: { id: 'pay_2', amount: 1000, method: 'upi', vpa: 'someone@okaxis' } },
        },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.method).toBe('upi');
    expect(draft.issuer).toBe('okaxis');
  });

  it('falls back to acquirer_data for the issuer', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: {
          payment: {
            entity: { id: 'pay_3', amount: 1000, method: 'card', acquirer_data: { bank: 'ICICI' } },
          },
        },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.issuer).toBe('icici');
  });

  it('maps emi onto the card rail', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: { payment: { entity: { id: 'p', amount: 1, method: 'emi' } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.method).toBe('card');
  });

  it('never stores an email or phone in the clear', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: {
          payment: { entity: { id: 'p', amount: 1, email: 'someone@example.com', contact: '+919999999999' } },
        },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.customerRef).toMatch(/^cust_[0-9a-f]{16}$/);
    expect(draft.customerRef).not.toContain('example.com');
    expect(draft.customerRef).not.toContain('9999');
  });

  it('derives the same opaque token for the same contact — the contact cap needs this', () => {
    const build = () =>
      unwrap(
        normalizeEvent({
          eventType: 'payment.failed',
          payload: { payment: { entity: { id: 'p', amount: 1, email: 'Repeat@Example.com' } } },
          receivedAt: RECEIVED_AT,
        }),
      ).draft.customerRef;
    expect(build()).toBe(build());
  });
});

describe('normalize — mandates', () => {
  it('maps subscription.halted with an attached failed payment', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'subscription.halted',
        payload: {
          subscription: { entity: { id: 'sub_TEST', customer_id: 'cust_M' } },
          payment: {
            entity: {
              amount: 49_900,
              currency: 'INR',
              method: 'emandate',
              bank: 'SBI',
              error_reason: 'insufficient_funds',
            },
          },
        },
        receivedAt: RECEIVED_AT,
      }),
    );

    expect(draft.source).toBe('mandate');
    expect(draft.externalRef).toBe('sub_TEST');
    expect(draft.amountPaise).toBe(49_900);
    expect(draft.method).toBe('emandate');
    expect(draft.issuer).toBe('sbi');
    expect(draft.errorReason).toBe('insufficient_funds');
  });

  it('maps subscription.pending to a mandate case', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'subscription.pending',
        payload: { subscription: { entity: { id: 'sub_P', customer_id: 'c' } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.source).toBe('mandate');
    // A mandate debit defaults to emandate when no payment entity says otherwise.
    expect(draft.method).toBe('emandate');
  });

  it('warns rather than failing when no amount is available', () => {
    const { draft, warnings } = unwrap(
      normalizeEvent({
        eventType: 'subscription.halted',
        payload: { subscription: { entity: { id: 'sub_X' } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.amountPaise).toBe(0);
    expect(warnings.join(' ')).toMatch(/amount/);
  });
});

describe('normalize — checkout abandonment', () => {
  it('maps a simulated checkout.abandoned event', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'checkout.abandoned',
        payload: {
          checkout: {
            entity: {
              id: 'order_ABANDON',
              amount: 750_000,
              currency: 'INR',
              method: 'upi',
              customer_id: 'cust_C',
            },
          },
        },
        receivedAt: RECEIVED_AT,
      }),
    );

    expect(draft.source).toBe('checkout');
    expect(draft.externalRef).toBe('order_ABANDON');
    expect(draft.amountPaise).toBe(750_000);
    // Nobody rejected anything — abandonment has no provider error.
    expect(draft.errorCode).toBeNull();
    expect(draft.errorSource).toBeNull();
    expect(draft.errorStep).toBeNull();
  });

  it('prefers amount_due over amount for a partially paid order', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'checkout.abandoned',
        payload: { order: { entity: { id: 'order_2', amount: 100_000, amount_due: 40_000 } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.amountPaise).toBe(40_000);
  });
});

describe('normalize — receivables', () => {
  it('maps invoice.expired to a receivable case using amount_due', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'invoice.expired',
        payload: {
          invoice: {
            entity: {
              id: 'inv_TEST',
              amount: 5_000_000,
              amount_paid: 1_000_000,
              amount_due: 4_000_000,
              currency: 'INR',
              customer_id: 'cust_R',
              status: 'expired',
            },
          },
        },
        receivedAt: RECEIVED_AT,
      }),
    );

    expect(draft.source).toBe('receivable');
    expect(draft.externalRef).toBe('inv_TEST');
    expect(draft.amountPaise).toBe(4_000_000);
    expect(draft.customerRef).toBe('cust_R');
  });
});

describe('normalize — malformed payloads never throw', () => {
  const malformed: readonly unknown[] = [
    {},
    null,
    undefined,
    'a string',
    42,
    [],
    { payment: null },
    { payment: { entity: null } },
    { payment: { entity: 'not an object' } },
    { payment: { entity: { amount: 'not a number' } } },
    { payment: { entity: { amount: -100 } } },
    { payment: { entity: { amount: 12.5 } } },
    { payment: { entity: { amount: [] } } },
  ];

  for (const [index, payload] of malformed.entries()) {
    it(`payload #${index} yields a null-filled case instead of throwing`, () => {
      const result = normalizeEvent({
        eventType: 'payment.failed',
        payload,
        receivedAt: RECEIVED_AT,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.draft.source).toBe('payment');
      // amount_paise is NOT NULL in the schema, so 0 plus a warning is the
      // honest outcome — visibly wrong and diagnosable, not silently dropped.
      expect(result.draft.amountPaise).toBe(0);
      expect(result.draft.currency).toBe('INR');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.draft.openedAt).toEqual(RECEIVED_AT);
    });
  }

  it('rejects a fractional amount rather than rounding money', () => {
    const { draft, warnings } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: { payment: { entity: { id: 'p', amount: 99.5 } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    // A fractional "paise" value means the field is really rupees. Rounding it
    // would silently corrupt money, so it is refused and warned about.
    expect(draft.amountPaise).toBe(0);
    expect(warnings.join(' ')).toMatch(/amount/);
  });

  it('accepts a numeric string amount', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: { payment: { entity: { id: 'p', amount: '250000' } } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.amountPaise).toBe(250_000);
  });

  it('produces a null-filled case for every source with an empty payload', () => {
    for (const eventType of [
      'payment.failed',
      'subscription.halted',
      'subscription.pending',
      'checkout.abandoned',
      'invoice.expired',
    ]) {
      const result = normalizeEvent({ eventType, payload: {}, receivedAt: RECEIVED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.draft.externalRef).toBeNull();
        expect(result.draft.customerRef).toBeNull();
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('normalize — event routing', () => {
  it('declines events that open no case', () => {
    for (const eventType of [
      'payment.captured',
      'order.paid',
      'payment_link.paid',
      'subscription.charged',
      'invoice.paid',
      'something.unknown',
    ]) {
      const result = normalizeEvent({ eventType, payload: {}, receivedAt: RECEIVED_AT });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(eventType);
    }
  });

  it('accepts a flattened payload without the entity wrapper', () => {
    const { draft } = unwrap(
      normalizeEvent({
        eventType: 'payment.failed',
        payload: { payment: { id: 'pay_flat', amount: 5000 } },
        receivedAt: RECEIVED_AT,
      }),
    );
    expect(draft.externalRef).toBe('pay_flat');
    expect(draft.amountPaise).toBe(5000);
  });

  it('uses the passed-in time and never the clock', () => {
    const t1 = new Date('2020-01-01T00:00:00.000Z');
    const t2 = new Date('2030-06-15T12:00:00.000Z');
    expect(
      unwrap(normalizeEvent({ eventType: 'payment.failed', payload: {}, receivedAt: t1 })).draft
        .openedAt,
    ).toEqual(t1);
    expect(
      unwrap(normalizeEvent({ eventType: 'payment.failed', payload: {}, receivedAt: t2 })).draft
        .openedAt,
    ).toEqual(t2);
  });
});
