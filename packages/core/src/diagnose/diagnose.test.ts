import { describe, expect, it } from 'vitest';
import {
  MIN_LLM_CONFIDENCE,
  diagnoseByRulesOnly,
  diagnoseCase,
  summariseDiagnoses,
  type Diagnosis,
} from './index';
import type { DowntimeWindow } from './downtime';
import type { DiagnosisTailPort, TailOutcome, TailRequest } from './port';
import type { DiagnosisInput } from './rules';

const T = (iso: string): Date => new Date(iso);
const FAILED_AT = T('2026-02-10T10:30:00.000Z');

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

/** A tail that returns whatever it is told to, and counts its calls. */
class StubTail implements DiagnosisTailPort {
  public calls = 0;
  public lastRequest: TailRequest | null = null;

  constructor(private readonly outcome: TailOutcome) {}

  async diagnose(request: TailRequest): Promise<TailOutcome> {
    this.calls += 1;
    this.lastRequest = request;
    return this.outcome;
  }
}

function verdict(overrides: Partial<{
  cause: string;
  confidence: number;
  reasoning: string;
  retried: boolean;
  cached: boolean;
}> = {}): TailOutcome {
  return {
    ok: true,
    verdict: {
      cause: (overrides.cause ?? 'issuer_down') as 'issuer_down',
      confidence: overrides.confidence ?? 0.9,
      reasoning: overrides.reasoning ?? 'because the bank endpoint was unreachable',
      model: 'test-model',
      cached: overrides.cached ?? false,
      retried: overrides.retried ?? false,
    },
  };
}

const UNMAPPED = input({
  errorCode: 'TEAPOT_ERROR',
  errorSource: 'aliens',
  errorStep: 'orbital_transfer',
  method: 'card',
});

describe('precedence: downtime > rules > LLM', () => {
  const downtime: DowntimeWindow[] = [
    {
      id: 'w1',
      issuer: 'hdfc',
      method: 'card',
      startedAt: T('2026-02-10T10:00:00.000Z'),
      resolvedAt: T('2026-02-10T11:00:00.000Z'),
      severity: 'high',
    },
  ];

  it('a confirmed downtime window wins, at confidence 1.0', async () => {
    // The tuple says insufficient_funds, but Razorpay told us the bank was down.
    const result = await diagnoseCase({
      input: input({
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        method: 'card',
        issuer: 'hdfc',
      }),
      failedAt: FAILED_AT,
      downtimeWindows: downtime,
    });

    expect(result.cause).toBe('issuer_down');
    expect(result.confidence).toBe(1);
    expect(result.causeBy).toBe('downtime_signal');
    expect(result.evidence).toContain('downtime_window:w1');
  });

  it('the rule table still works with NO downtime data — the synthetic lane', async () => {
    const result = await diagnoseCase({
      input: input({
        errorCode: 'GATEWAY_ERROR',
        errorSource: 'issuer',
        errorStep: 'payment_authorization',
        method: 'upi',
        issuer: 'hdfc',
      }),
      failedAt: FAILED_AT,
      downtimeWindows: [],
    });

    expect(result.cause).toBe('issuer_down');
    expect(result.causeBy).toBe('rule');
    expect(result.confidence).toBe(1);
  });

  it('a downtime window for a different issuer does not hijack the diagnosis', async () => {
    const result = await diagnoseCase({
      input: input({
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        method: 'card',
        issuer: 'icici',
      }),
      failedAt: FAILED_AT,
      downtimeWindows: downtime,
    });

    expect(result.cause).toBe('insufficient_funds');
    expect(result.causeBy).toBe('rule');
  });

  it('the LLM is never called when a rule matches', async () => {
    const tail = new StubTail(verdict());
    await diagnoseCase({
      input: input({
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        method: 'card',
      }),
      failedAt: FAILED_AT,
      tail,
    });
    expect(tail.calls).toBe(0);
  });

  it('the LLM is called only for an unmapped tuple', async () => {
    const tail = new StubTail(verdict());
    const result = await diagnoseCase({ input: UNMAPPED, failedAt: FAILED_AT, tail });
    expect(tail.calls).toBe(1);
    expect(result.causeBy).toBe('llm');
    expect(result.cause).toBe('issuer_down');
  });

  it('constrains the LLM to the causes legal for the surface', async () => {
    const tail = new StubTail(verdict());
    await diagnoseCase({
      input: { ...UNMAPPED, source: 'receivable' },
      failedAt: FAILED_AT,
      tail,
    });
    const allowed = tail.lastRequest?.allowedCauses ?? [];
    expect(allowed).toContain('overdue_soft');
    expect(allowed).toContain('disputed_invoice');
    expect(allowed).toContain('fraud_flag');
    // A payment-only cause must not be offered for an invoice.
    expect(allowed).not.toContain('invalid_vpa');
  });
});

describe('unknown, without a tail', () => {
  it('an unmapped tuple with no tail is unknown and routed to exceptions', async () => {
    const result = await diagnoseCase({ input: UNMAPPED, failedAt: FAILED_AT });
    expect(result.cause).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.exceptionReason).toContain('no_rule_match_no_tail');
  });
});

describe('confidence threshold', () => {
  it(`accepts a verdict at or above ${MIN_LLM_CONFIDENCE}`, async () => {
    for (const confidence of [MIN_LLM_CONFIDENCE, 0.8, 1]) {
      const result = await diagnoseCase({
        input: UNMAPPED,
        failedAt: FAILED_AT,
        tail: new StubTail(verdict({ confidence })),
      });
      expect(result.cause, `confidence ${confidence}`).toBe('issuer_down');
      expect(result.exceptionReason).toBeNull();
    }
  });

  it(`discards a verdict below ${MIN_LLM_CONFIDENCE} as unknown`, async () => {
    for (const confidence of [0, 0.1, 0.5, 0.69]) {
      const result = await diagnoseCase({
        input: UNMAPPED,
        failedAt: FAILED_AT,
        tail: new StubTail(verdict({ confidence })),
      });
      expect(result.cause, `confidence ${confidence}`).toBe('unknown');
      expect(result.causeBy).toBe('llm');
      expect(result.exceptionReason).toContain('low_confidence');
      // The confidence is kept, so the exception list shows how close it was.
      expect(result.confidence).toBe(confidence);
    }
  });
});

describe('taxonomy enforcement on the LLM', () => {
  it('rejects a cause that is not legal for the surface', async () => {
    const result = await diagnoseCase({
      // invalid_vpa is a payment cause; this is an invoice.
      input: { ...UNMAPPED, source: 'receivable' },
      failedAt: FAILED_AT,
      tail: new StubTail(verdict({ cause: 'invalid_vpa' })),
    });
    expect(result.cause).toBe('unknown');
    expect(result.exceptionReason).toContain('not a legal cause');
  });

  it('keeps an honest abstention as unknown rather than an error', async () => {
    const result = await diagnoseCase({
      input: UNMAPPED,
      failedAt: FAILED_AT,
      tail: new StubTail(verdict({ cause: 'unknown', confidence: 0.9 })),
    });
    expect(result.cause).toBe('unknown');
    expect(result.causeBy).toBe('llm');
    expect(result.exceptionReason).toContain('llm_abstained');
  });
});

describe('tail failures degrade to unknown, never throw', () => {
  const failures: readonly {
    reason: 'invalid_response' | 'injection_suspected' | 'rate_limited' | 'transport_error';
    retried: boolean;
  }[] = [
    { reason: 'invalid_response', retried: true },
    { reason: 'injection_suspected', retried: false },
    { reason: 'rate_limited', retried: false },
    { reason: 'transport_error', retried: false },
  ];

  for (const { reason, retried } of failures) {
    it(`${reason} becomes unknown with the reason recorded`, async () => {
      const tail = new StubTail({ ok: false, reason, detail: `stub ${reason}`, retried });
      const result = await diagnoseCase({ input: UNMAPPED, failedAt: FAILED_AT, tail });

      expect(result.cause).toBe('unknown');
      expect(result.exceptionReason).toContain(reason);
      expect(result.parseRetried).toBe(retried);
    });
  }

  it('does not throw when the tail itself rejects', async () => {
    const throwing: DiagnosisTailPort = {
      async diagnose() {
        throw new Error('network exploded');
      },
    };
    // diagnoseCase does not catch: the worker does, per case. Assert the shape of
    // the failure so the worker contract is explicit.
    await expect(
      diagnoseCase({ input: UNMAPPED, failedAt: FAILED_AT, tail: throwing }),
    ).rejects.toThrow('network exploded');
  });
});

describe('diagnoseByRulesOnly', () => {
  it('is synchronous and reports the rule id', () => {
    const result = diagnoseByRulesOnly(
      input({
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        method: 'card',
      }),
    );
    expect(result.cause).toBe('insufficient_funds');
    expect(result.ruleId).toBe('payment.insufficient_funds');
  });

  it('returns unknown with a null rule id when nothing matches', () => {
    expect(diagnoseByRulesOnly(UNMAPPED)).toEqual({ cause: 'unknown', ruleId: null });
  });

  it('derives the receivable day count from error_reason', () => {
    const result = diagnoseByRulesOnly(
      input({
        source: 'receivable',
        errorCode: 'INVOICE_EXPIRED',
        errorSource: 'business',
        errorStep: 'invoice_settlement',
        errorReason: 'invoice_past_due_date:40',
      }),
    );
    expect(result.cause).toBe('overdue_hard');
  });
});

describe('summariseDiagnoses', () => {
  const make = (overrides: Partial<Diagnosis>): Diagnosis => ({
    cause: 'issuer_down',
    confidence: 1,
    causeBy: 'rule',
    evidence: 'rule:x',
    reasoning: null,
    exceptionReason: null,
    parseRetried: false,
    cached: false,
    ...overrides,
  });

  it('splits by rule, LLM, and downtime signal', () => {
    const summary = summariseDiagnoses([
      make({}),
      make({}),
      make({ causeBy: 'downtime_signal' }),
      make({ causeBy: 'llm', confidence: 0.9 }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.byRule).toBe(2);
    expect(summary.byDowntimeSignal).toBe(1);
    expect(summary.byLlm).toBe(1);
    expect(summary.ruleShare).toBeCloseTo(0.5);
  });

  it('computes the unknown rate', () => {
    const summary = summariseDiagnoses([make({}), make({ cause: 'unknown' })]);
    expect(summary.unknown).toBe(1);
    expect(summary.unknownRate).toBeCloseTo(0.5);
  });

  it('computes the parse-failure rate over LLM calls only', () => {
    const summary = summariseDiagnoses([
      make({}),
      make({ causeBy: 'llm', parseRetried: true }),
      make({ causeBy: 'llm', parseRetried: false }),
    ]);
    expect(summary.llmCalls).toBe(2);
    expect(summary.llmParseRetries).toBe(1);
    expect(summary.parseFailureRate).toBeCloseTo(0.5);
  });

  it('handles an empty batch without dividing by zero', () => {
    const summary = summariseDiagnoses([]);
    expect(summary.total).toBe(0);
    expect(summary.ruleShare).toBe(0);
    expect(summary.parseFailureRate).toBe(0);
  });

  it('counts cache hits', () => {
    const summary = summariseDiagnoses([make({ causeBy: 'llm', cached: true })]);
    expect(summary.cacheHits).toBe(1);
  });
});
