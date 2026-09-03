import { describe, expect, it } from 'vitest';
import type { CaseSource, PaymentMethod } from '../types/enums';
import {
  DIAGNOSIS_RULES,
  applyRuleTable,
  causesCoveredByRules,
  parseDaysOverdue,
  type DiagnosisInput,
} from './rules';
import {
  ALL_CAUSES,
  CHECKOUT_CAUSES,
  MANDATE_CAUSES,
  PAYMENT_CAUSES,
  RECEIVABLE_CAUSES,
  TERMINAL_CAUSES,
  isRootCause,
} from './taxonomy';

/**
 * Every mapping in docs/POLICY_SPEC.md §1 has a test here.
 *
 * The table is the default path for every case, so a wrong row silently sends
 * real money at the wrong intervention. These tests are the contract.
 */

function input(overrides: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    source: 'payment',
    errorCode: null,
    errorSource: null,
    errorStep: null,
    errorReason: null,
    method: null,
    issuer: null,
    daysOverdue: null,
    ...overrides,
  };
}

function expectCause(overrides: Partial<DiagnosisInput>, cause: string): void {
  const result = applyRuleTable(input(overrides));
  expect(result, `expected ${cause} for ${JSON.stringify(overrides)}`).not.toBeNull();
  expect(result?.cause).toBe(cause);
}

describe('taxonomy is closed', () => {
  it('has exactly 21 causes', () => {
    expect(ALL_CAUSES).toHaveLength(21);
    expect(PAYMENT_CAUSES).toHaveLength(8);
    expect(MANDATE_CAUSES).toHaveLength(4);
    expect(CHECKOUT_CAUSES).toHaveLength(3);
    expect(RECEIVABLE_CAUSES).toHaveLength(3);
    expect(TERMINAL_CAUSES).toHaveLength(3);
  });

  it('matches POLICY_SPEC §1 exactly', () => {
    expect([...PAYMENT_CAUSES]).toEqual([
      'issuer_down',
      'issuer_declined',
      'gateway_timeout',
      'insufficient_funds',
      'otp_abandoned',
      'invalid_vpa',
      'expired_card',
      'merchant_config_error',
    ]);
    expect([...MANDATE_CAUSES]).toEqual([
      'mandate_debit_failed',
      'mandate_insufficient_balance',
      'mandate_revoked',
      'mandate_expired',
    ]);
    expect([...CHECKOUT_CAUSES]).toEqual([
      'abandoned_at_method',
      'abandoned_at_auth',
      'price_hesitation',
    ]);
    expect([...RECEIVABLE_CAUSES]).toEqual(['overdue_soft', 'overdue_hard', 'disputed_invoice']);
    expect([...TERMINAL_CAUSES]).toEqual(['fraud_flag', 'chargeback', 'customer_opt_out']);
  });

  it('rejects anything outside the taxonomy', () => {
    expect(isRootCause('issuer_down')).toBe(true);
    // The Run 2 generator's illegal vocabulary. Must never be accepted again.
    for (const illegal of [
      'invoice_overdue',
      'invoice_disputed',
      'invoice_awaiting_po',
      'checkout_abandoned_price',
      'mandate_paused',
      'mandate_pre_debit_missing',
      'unknown',
      'bank_sad',
      '',
    ]) {
      expect(isRootCause(illegal), illegal).toBe(false);
    }
  });

  it('every rule produces a legal cause', () => {
    for (const rule of DIAGNOSIS_RULES) {
      expect(isRootCause(rule.cause), rule.id).toBe(true);
    }
  });

  it('every rule has a rationale, so no row is unexplained', () => {
    for (const rule of DIAGNOSIS_RULES) {
      expect(rule.rationale.length, rule.id).toBeGreaterThan(20);
    }
  });

  it('rule ids are unique', () => {
    const ids = DIAGNOSIS_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('rule table — payments, all 8', () => {
  it('issuer_down: GATEWAY_ERROR from the issuer at authorization', () => {
    expectCause(
      {
        errorCode: 'GATEWAY_ERROR',
        errorSource: 'issuer',
        errorStep: 'payment_authorization',
        method: 'upi',
      },
      'issuer_down',
    );
  });

  it('gateway_timeout: GATEWAY_ERROR from the gateway itself', () => {
    expectCause(
      {
        errorCode: 'GATEWAY_ERROR',
        errorSource: 'gateway',
        errorStep: 'payment_authorization',
        method: 'card',
      },
      'gateway_timeout',
    );
  });

  it('insufficient_funds: the BANK declined at authorization', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        method: 'card',
      },
      'insufficient_funds',
    );
  });

  it('issuer_declined: the ISSUER declined at authorization', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'issuer',
        errorStep: 'payment_authorization',
        method: 'card',
      },
      'issuer_declined',
    );
  });

  /** bank vs issuer is the whole distinction. Assert it does not blur. */
  it('bank and issuer declines are different causes', () => {
    const base = {
      errorCode: 'BAD_REQUEST_ERROR',
      errorStep: 'payment_authorization',
      method: 'card' as PaymentMethod,
    };
    expect(applyRuleTable(input({ ...base, errorSource: 'bank' }))?.cause).toBe(
      'insufficient_funds',
    );
    expect(applyRuleTable(input({ ...base, errorSource: 'issuer' }))?.cause).toBe(
      'issuer_declined',
    );
  });

  it('otp_abandoned: customer dropped at authentication', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_authentication',
        method: 'card',
      },
      'otp_abandoned',
    );
  });

  it('invalid_vpa: customer error at initiation on UPI', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_initiation',
        method: 'upi',
      },
      'invalid_vpa',
    );
  });

  it('expired_card: the same tuple on the card rail', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_initiation',
        method: 'card',
      },
      'expired_card',
    );
  });

  it('invalid_vpa and expired_card are separated only by the rail', () => {
    const base = {
      errorCode: 'BAD_REQUEST_ERROR',
      errorSource: 'customer',
      errorStep: 'payment_initiation',
    };
    expect(applyRuleTable(input({ ...base, method: 'upi' }))?.cause).toBe('invalid_vpa');
    expect(applyRuleTable(input({ ...base, method: 'card' }))?.cause).toBe('expired_card');
    // No rail named: neither rule can claim it, so the tail takes it.
    expect(applyRuleTable(input({ ...base, method: null }))).toBeNull();
  });

  it('merchant_config_error: Razorpay blames the business', () => {
    expectCause(
      {
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'business',
        errorStep: 'payment_initiation',
        method: 'card',
      },
      'merchant_config_error',
    );
  });
});

describe('rule table — mandates, all 4', () => {
  const mandate = { source: 'mandate' as CaseSource, method: 'emandate' as PaymentMethod };

  it('mandate_insufficient_balance: bank declined the scheduled debit', () => {
    expectCause(
      {
        ...mandate,
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
      },
      'mandate_insufficient_balance',
    );
  });

  it('mandate_debit_failed: issuer or transit failure, mandate intact', () => {
    expectCause(
      {
        ...mandate,
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'issuer',
        errorStep: 'payment_authorization',
      },
      'mandate_debit_failed',
    );
  });

  it('mandate_revoked: customer refused on a mandate rail', () => {
    expectCause(
      {
        ...mandate,
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_authorization',
      },
      'mandate_revoked',
    );
  });

  it('mandate_expired: rejected at initiation', () => {
    expectCause(
      {
        ...mandate,
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_initiation',
      },
      'mandate_expired',
    );
  });

  /**
   * The mandate rail is what stops a mandate debit being read as a one-off
   * payment. Same tuple, different surface, different cause.
   */
  it('the same bank decline means different things on different surfaces', () => {
    const base = {
      errorCode: 'BAD_REQUEST_ERROR',
      errorSource: 'bank',
      errorStep: 'payment_authorization',
    };
    expect(
      applyRuleTable(input({ ...base, source: 'payment', method: 'card' }))?.cause,
    ).toBe('insufficient_funds');
    expect(
      applyRuleTable(input({ ...base, source: 'mandate', method: 'emandate' }))?.cause,
    ).toBe('mandate_insufficient_balance');
  });
});

describe('rule table — checkout, all 3', () => {
  const checkout = { source: 'checkout' as CaseSource, errorCode: 'CHECKOUT_ABANDONED' };

  it('abandoned_at_method', () => {
    expectCause({ ...checkout, errorStep: 'checkout_method_selection' }, 'abandoned_at_method');
  });

  it('abandoned_at_auth', () => {
    expectCause({ ...checkout, errorStep: 'checkout_authentication' }, 'abandoned_at_auth');
  });

  it('price_hesitation', () => {
    expectCause({ ...checkout, errorStep: 'checkout_review' }, 'price_hesitation');
  });

  it('an unknown checkout stage falls through to the tail', () => {
    expect(applyRuleTable(input({ ...checkout, errorStep: 'checkout_teleport' }))).toBeNull();
  });
});

describe('rule table — receivables, all 3', () => {
  const receivable = {
    source: 'receivable' as CaseSource,
    errorCode: 'INVOICE_EXPIRED',
    errorStep: 'invoice_settlement',
  };

  it('disputed_invoice: the customer is the reason, not the calendar', () => {
    expectCause({ ...receivable, errorSource: 'customer' }, 'disputed_invoice');
  });

  it('overdue_soft below the 15-day threshold', () => {
    for (const days of [0, 1, 7, 14]) {
      expectCause({ ...receivable, errorSource: 'business', daysOverdue: days }, 'overdue_soft');
    }
  });

  it('overdue_hard at or above the 15-day threshold', () => {
    for (const days of [15, 16, 60, 400]) {
      expectCause({ ...receivable, errorSource: 'business', daysOverdue: days }, 'overdue_hard');
    }
  });

  it('reads the day count out of a structured error_reason', () => {
    expectCause(
      {
        ...receivable,
        errorSource: 'business',
        errorReason: 'invoice_past_due_date:23',
      },
      'overdue_hard',
    );
    expectCause(
      {
        ...receivable,
        errorSource: 'business',
        errorReason: 'invoice_past_due_date:3',
      },
      'overdue_soft',
    );
  });

  it('an overdue invoice with no day count falls through to the tail', () => {
    expect(
      applyRuleTable(
        input({ ...receivable, errorSource: 'business', errorReason: 'invoice_past_due_date' }),
      ),
    ).toBeNull();
  });

  it('a dispute outranks the day count', () => {
    expectCause(
      { ...receivable, errorSource: 'customer', daysOverdue: 90 },
      'disputed_invoice',
    );
  });
});

describe('rule table — terminal causes, on every surface', () => {
  it('fraud_flag on all four surfaces', () => {
    for (const source of ['payment', 'mandate', 'checkout', 'receivable'] as const) {
      expectCause(
        {
          source,
          errorCode: 'BAD_REQUEST_ERROR',
          errorSource: 'internal',
          errorStep: 'payment_authorization',
        },
        'fraud_flag',
      );
    }
  });

  it('chargeback on all four surfaces', () => {
    for (const source of ['payment', 'mandate', 'checkout', 'receivable'] as const) {
      expectCause(
        { source, errorCode: 'BAD_REQUEST_ERROR', errorSource: 'bank', errorStep: 'settlement' },
        'chargeback',
      );
    }
  });

  it('customer_opt_out on a non-mandate rail, on any surface', () => {
    for (const source of ['payment', 'checkout', 'receivable'] as const) {
      expectCause(
        {
          source,
          errorCode: 'BAD_REQUEST_ERROR',
          errorSource: 'customer',
          errorStep: 'payment_authorization',
          method: 'card',
        },
        'customer_opt_out',
      );
    }
  });

  /**
   * A known, reported limitation: on a mandate rail `customer_opt_out` and
   * `mandate_revoked` are indistinguishable from the error fields. Both are
   * terminal, so the agent stops either way and the money outcome is identical.
   */
  it('prefers mandate_revoked on a mandate rail, and both are terminal', () => {
    expectCause(
      {
        source: 'mandate',
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'customer',
        errorStep: 'payment_authorization',
        method: 'emandate',
      },
      'mandate_revoked',
    );
  });

  it('terminal rules are ordered before anything that could act', () => {
    const firstNonTerminal = DIAGNOSIS_RULES.findIndex((r) => !r.id.startsWith('terminal.'));
    const lastTerminal = DIAGNOSIS_RULES.map((r) => r.id.startsWith('terminal.')).lastIndexOf(true);
    expect(lastTerminal).toBeLessThan(firstNonTerminal);
  });
});

describe('rule table — field normalisation', () => {
  it('accepts a step with or without the payment_ prefix', () => {
    for (const step of ['payment_authorization', 'authorization', 'authorisation']) {
      expectCause(
        {
          errorCode: 'BAD_REQUEST_ERROR',
          errorSource: 'bank',
          errorStep: step,
          method: 'card',
        },
        'insufficient_funds',
      );
    }
  });

  it('is case-insensitive', () => {
    expectCause(
      {
        errorCode: 'bad_request_error',
        errorSource: 'BANK',
        errorStep: 'Payment_Authorization',
        method: 'card',
      },
      'insufficient_funds',
    );
  });

  it('tolerates surrounding whitespace', () => {
    expectCause(
      {
        errorCode: ' BAD_REQUEST_ERROR ',
        errorSource: ' bank ',
        errorStep: ' payment_authorization ',
        method: 'card',
      },
      'insufficient_funds',
    );
  });
});

describe('rule table — no match', () => {
  it('returns null for an empty input rather than guessing', () => {
    expect(applyRuleTable(input())).toBeNull();
  });

  it('returns null for an unrecognised tuple', () => {
    expect(
      applyRuleTable(
        input({
          errorCode: 'TEAPOT_ERROR',
          errorSource: 'aliens',
          errorStep: 'orbital_transfer',
          method: 'card',
        }),
      ),
    ).toBeNull();
  });

  it('never throws on hostile input', () => {
    expect(() =>
      applyRuleTable(
        input({
          errorCode: '\u0000\u0001',
          errorSource: 'a'.repeat(10_000),
          errorStep: '💥',
        }),
      ),
    ).not.toThrow();
  });
});

describe('parseDaysOverdue', () => {
  it('reads a trailing day count', () => {
    expect(parseDaysOverdue('invoice_past_due_date:23')).toBe(23);
    expect(parseDaysOverdue('invoice_past_due_date:0')).toBe(0);
  });

  it('returns null when there is no count', () => {
    for (const value of [null, '', 'invoice_past_due_date', 'x:', 'x:-4', 'x:abc', 'x:1.5']) {
      expect(parseDaysOverdue(value), String(value)).toBeNull();
    }
  });
});

describe('rule table coverage of the taxonomy', () => {
  it('covers every cause except the deliberately LLM-only ones', () => {
    const covered = new Set(causesCoveredByRules());
    const uncovered = ALL_CAUSES.filter((c) => !covered.has(c));
    // The table is expected to reach all 21. If a cause is unreachable the LLM
    // would be carrying it, which POLICY_SPEC §6 says is the wrong way round.
    expect(uncovered).toEqual([]);
  });
});
