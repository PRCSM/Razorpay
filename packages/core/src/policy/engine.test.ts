import { describe, expect, it } from 'vitest';
import { ALL_CAUSES, type RootCause } from '../diagnose/taxonomy';
import type { DowntimeWindow } from '../diagnose/downtime';
import { StaticTimingStrategy } from '../timing/static-strategy';
import { buildPlan, expectedValuePaise } from './engine';
import { INTERVENTIONS, estimateCostPaise, interventionForAttempt } from './interventions';
import { parsePolicy, type PolicyConfig } from './schema';
import type { PlanningCase, PlanningContext } from './engine';

const NOW = new Date('2026-02-10T12:00:00.000Z'); // 17:30 IST, mid-month

function policy(overrides: Record<string, unknown> = {}): PolicyConfig {
  return parsePolicy({
    version: '1.0.0',
    kill_switch: false,
    gates: {
      injection_screen: {
        enabled: true,
        model: 'm',
        threshold: 0.8,
        on_detect: 'flag_and_skip_llm',
      },
      attempt_cap: { enabled: true, max_attempts: 3 },
      cooling_window: { enabled: true, hours: 4, on_fail: 'reschedule_to_boundary' },
      contact_cap: { enabled: true, max_per_customer_per_day: 3, on_fail: 'downgrade_to_non_contact' },
      quiet_hours: {
        enabled: true,
        start: '21:00',
        end: '09:00',
        tz: 'Asia/Kolkata',
        applies_to: ['nudge', 'pre_debit_notice', 'promise_to_pay'],
        on_fail: 'reschedule_to_window_open',
      },
      terminal_check: {
        enabled: true,
        causes: ['fraud_flag', 'chargeback', 'customer_opt_out', 'mandate_revoked'],
        on_fail: 'stop_case',
      },
      amount_ceiling: { enabled: true, max_autonomous_paise: 2_500_000, on_fail: 'escalate_human' },
      compliance: {
        enabled: true,
        mandate_requires_pre_debit_notice: true,
        pre_debit_notice_lead_hours: 24,
        sms_requires_dlt_template_id: true,
        on_fail: 'drop_and_log',
      },
    },
    costs: {
      sms_paise: 20,
      whatsapp_paise: 80,
      human_escalation_paise: 5000,
      retry_paise: 0,
      payment_link_paise: 0,
    },
    attribution: { window_hours: 72 },
    timing: { strategy: 'static', bandit_arms_hours: [2, 6, 18, 48], salary_window_days: [1, 2, 3] },
    ...overrides,
  }, 'test');
}

function planningCase(overrides: Partial<PlanningCase> = {}): PlanningCase {
  return {
    id: 'case-1',
    source: 'payment',
    rootCause: 'insufficient_funds',
    causeBy: 'rule',
    amountPaise: 250_000,
    currency: 'INR',
    customerRef: 'cust_0001',
    issuer: 'hdfc',
    method: 'card',
    attemptCount: 0,
    ...overrides,
  };
}

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    policy: policy(),
    strategy: new StaticTimingStrategy(),
    demoTimeScale: 1,
    dltTemplateId: 'DLT_TEST_01',
    ...overrides,
  };
}

/** Which source each cause belongs to, for building a valid case per cause. */
const SOURCE_FOR_CAUSE: Readonly<Record<string, PlanningCase['source']>> = {
  mandate_debit_failed: 'mandate',
  mandate_insufficient_balance: 'mandate',
  mandate_revoked: 'mandate',
  mandate_expired: 'mandate',
  abandoned_at_method: 'checkout',
  abandoned_at_auth: 'checkout',
  price_hesitation: 'checkout',
  overdue_soft: 'receivable',
  overdue_hard: 'receivable',
  disputed_invoice: 'receivable',
};

// ---------------------------------------------------------------------------
// TASK 1 — every cause maps to something
// ---------------------------------------------------------------------------

describe('TASK 1 — all 21 causes map to an intervention', () => {
  it('the map covers the taxonomy exactly, with nothing extra', () => {
    expect(Object.keys(INTERVENTIONS).sort()).toEqual([...ALL_CAUSES].sort());
    expect(Object.keys(INTERVENTIONS)).toHaveLength(21);
  });

  it('every cause has a non-empty ladder and a rationale', () => {
    for (const cause of ALL_CAUSES) {
      const plan = INTERVENTIONS[cause];
      expect(plan.ladder.length, cause).toBeGreaterThan(0);
      expect(plan.rationale.length, cause).toBeGreaterThan(20);
    }
  });

  /** Completion criterion 1: no cause falls through unhandled. */
  it('every cause produces a plan — none falls through', () => {
    for (const cause of ALL_CAUSES) {
      const outcome = buildPlan(
        planningCase({
          rootCause: cause,
          source: SOURCE_FOR_CAUSE[cause] ?? 'payment',
        }),
        context(),
        NOW,
      );

      expect(outcome.ok, `${cause} produced no plan`).toBe(true);
      if (outcome.ok) {
        expect(outcome.plan.actionType.length).toBeGreaterThan(0);
        expect(Number.isFinite(outcome.plan.scheduledFor.getTime())).toBe(true);
      }
    }
  });

  it('terminal causes map to stop, at zero cost and zero expected recovery', () => {
    for (const cause of ['fraud_flag', 'chargeback', 'customer_opt_out', 'mandate_revoked'] as const) {
      const outcome = buildPlan(
        planningCase({ rootCause: cause, source: SOURCE_FOR_CAUSE[cause] ?? 'payment' }),
        context(),
        NOW,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.plan.actionType, cause).toBe('stop');
        expect(outcome.plan.estCostPaise).toBe(0);
        expect(outcome.plan.expectedP).toBe(0);
        expect(outcome.plan.isContact).toBe(false);
      }
    }
  });

  it('price_hesitation stops — pricing is not a recovery problem', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'price_hesitation', source: 'checkout' }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.actionType).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// The POLICY_SPEC §3 map, spot-checked per surface
// ---------------------------------------------------------------------------

describe('cause → intervention, per POLICY_SPEC §3', () => {
  const firstAction = (cause: RootCause, attemptCount = 0): string => {
    const outcome = buildPlan(
      planningCase({
        rootCause: cause,
        attemptCount,
        source: SOURCE_FOR_CAUSE[cause] ?? 'payment',
      }),
      context(),
      NOW,
    );
    return outcome.ok ? outcome.plan.actionType : `NO_PLAN:${outcome.reason}`;
  };

  it('payments', () => {
    expect(firstAction('issuer_down')).toBe('delayed_retry');
    expect(firstAction('gateway_timeout')).toBe('immediate_retry');
    expect(firstAction('otp_abandoned')).toBe('immediate_retry');
    expect(firstAction('issuer_declined')).toBe('delayed_retry');
    expect(firstAction('insufficient_funds')).toBe('delayed_retry');
    expect(firstAction('invalid_vpa')).toBe('payment_link');
    expect(firstAction('expired_card')).toBe('payment_link');
    expect(firstAction('merchant_config_error')).toBe('escalate_human');
  });

  it('issuer_declined escalates to a method switch on the second attempt', () => {
    expect(firstAction('issuer_declined', 1)).toBe('method_switch');
  });

  it('otp_abandoned offers an easier rail on the second attempt', () => {
    expect(firstAction('otp_abandoned', 1)).toBe('method_switch');
  });

  /** Gate 7 enforces notice-before-re-presentment; the ladder must put it first. */
  it('mandates lead with the pre-debit notice', () => {
    expect(firstAction('mandate_debit_failed')).toBe('pre_debit_notice');
    expect(firstAction('mandate_insufficient_balance')).toBe('pre_debit_notice');
    // Only then the re-presentment.
    expect(firstAction('mandate_debit_failed', 1)).toBe('delayed_retry');
    expect(firstAction('mandate_expired')).toBe('nudge');
  });

  it('checkout', () => {
    expect(firstAction('abandoned_at_method')).toBe('payment_link');
    expect(firstAction('abandoned_at_auth')).toBe('nudge');
  });

  it('receivables', () => {
    expect(firstAction('overdue_soft')).toBe('nudge');
    expect(firstAction('overdue_hard')).toBe('promise_to_pay');
    expect(firstAction('disputed_invoice')).toBe('escalate_human');
  });

  it('merchant_config_error never contacts the customer about our own bug', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'merchant_config_error' }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.isContact).toBe(false);
      expect(outcome.plan.channel).toBe('none');
    }
  });

  it('issuer_down never messages — it is not the customer\'s fault', () => {
    for (const attemptCount of [0, 1, 2]) {
      const outcome = buildPlan(
        planningCase({ rootCause: 'issuer_down', attemptCount }),
        context(),
        NOW,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.plan.isContact, `attempt ${attemptCount}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Costs come from policy.yaml
// ---------------------------------------------------------------------------

describe('costs come from policy.yaml, never hardcoded', () => {
  it('an SMS nudge costs the policy sms_paise', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'overdue_soft', source: 'receivable' }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.estCostPaise).toBe(20);
  });

  it('changing the YAML cost changes the estimate', () => {
    const dearer = policy({
      costs: {
        sms_paise: 999,
        whatsapp_paise: 80,
        human_escalation_paise: 5000,
        retry_paise: 0,
        payment_link_paise: 0,
      },
    });
    const outcome = buildPlan(
      planningCase({ rootCause: 'overdue_soft', source: 'receivable' }),
      context({ policy: dearer }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.estCostPaise).toBe(999);
  });

  it('a WhatsApp promise_to_pay costs whatsapp_paise', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'overdue_hard', source: 'receivable' }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.estCostPaise).toBe(80);
  });

  it('a retry and a payment link are free', () => {
    for (const cause of ['issuer_down', 'invalid_vpa'] as const) {
      const outcome = buildPlan(planningCase({ rootCause: cause }), context(), NOW);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.plan.estCostPaise, cause).toBe(0);
    }
  });

  it('escalation costs the staff-time figure', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'merchant_config_error' }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.estCostPaise).toBe(5000);
  });

  /**
   * Failing closed on money means assuming an action is EXPENSIVE. A broken cost
   * model must not make a wasteful plan look free to the cost-per-rupee metric.
   */
  it('a malformed cost falls back to the expensive figure, not to zero', () => {
    const broken = structuredClone(policy()) as PolicyConfig;
    (broken.costs as { sms_paise: number }).sms_paise = Number.NaN;

    const cost = estimateCostPaise(
      { actionType: 'nudge', channel: 'sms', costBasis: 'sms_paise', expectedP: 0.3, isContact: true },
      broken.costs,
    );
    expect(cost).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('the engine refuses rather than guessing', () => {
  it('refuses an undiagnosed case', () => {
    for (const rootCause of [null, '']) {
      const outcome = buildPlan(planningCase({ rootCause }), context(), NOW);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('undiagnosed');
    }
  });

  it('refuses an unknown cause — that case belongs to the exception list', () => {
    const outcome = buildPlan(planningCase({ rootCause: 'unknown' }), context(), NOW);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unknown_cause');
  });

  it('refuses a cause outside the closed taxonomy', () => {
    for (const rootCause of ['invoice_overdue', 'bank_was_grumpy', 'mandate_paused']) {
      const outcome = buildPlan(planningCase({ rootCause }), context(), NOW);
      expect(outcome.ok, rootCause).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('invalid_cause');
    }
  });

  it('refuses once the ladder is exhausted', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'invalid_vpa', attemptCount: 2 }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ladder_exhausted');
  });

  it('treats a NaN attempt count as zero rather than crashing', () => {
    const outcome = buildPlan(
      planningCase({ attemptCount: Number.NaN as never }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK 3 — downtime-aware planning
// ---------------------------------------------------------------------------

describe('TASK 3 — downtime-aware planning', () => {
  const openWindow: DowntimeWindow = {
    id: 'w-open',
    issuer: 'hdfc',
    method: 'card',
    startedAt: new Date('2026-02-10T11:00:00.000Z'),
    resolvedAt: null,
    severity: 'high',
  };

  const resolvedWindow: DowntimeWindow = {
    ...openWindow,
    id: 'w-resolved',
    resolvedAt: new Date('2026-02-10T14:00:00.000Z'),
  };

  it('an OPEN outage produces a re-check, not a money action', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'issuer_down', causeBy: 'downtime_signal' }),
      context({ downtimeWindow: openWindow }),
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.recheckOnly).toBe(true);
    expect(outcome.plan.timing.basis).toBe('downtime_recheck');
    expect(outcome.plan.isContact).toBe(false);
    expect(outcome.plan.estCostPaise).toBe(0);
    // Nothing is promised while the bank is down.
    expect(outcome.plan.expectedP).toBe(0);
    expect(outcome.plan.timing.reason).toMatch(/still OPEN/);
  });

  it('a RESOLVED outage schedules relative to resolved_at, not a static +2h', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'issuer_down', causeBy: 'downtime_signal' }),
      context({ downtimeWindow: resolvedWindow }),
      NOW,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.plan.recheckOnly).toBe(false);
    expect(outcome.plan.timing.basis).toBe('downtime_resolved');
    // resolved 14:00 + 0.5h grace = 14:30, NOT NOW + 2h = 14:00.
    expect(outcome.plan.scheduledFor.toISOString()).toBe('2026-02-10T14:30:00.000Z');
  });

  it('retries immediately when the outage resolved before now', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'issuer_down', causeBy: 'downtime_signal' }),
      context({
        downtimeWindow: { ...resolvedWindow, resolvedAt: new Date('2026-02-10T09:00:00.000Z') },
      }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.scheduledFor.getTime()).toBe(NOW.getTime());
      expect(outcome.plan.recheckOnly).toBe(false);
    }
  });

  /** The inference path must keep working — the synthetic lane has no downtime. */
  it('falls back to the static table with NO downtime window', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'issuer_down', causeBy: 'rule' }),
      context({ downtimeWindow: null }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.timing.basis).toBe('static_table');
      // The documented +2h.
      expect(outcome.plan.scheduledFor.toISOString()).toBe('2026-02-10T14:00:00.000Z');
    }
  });

  it('ignores a downtime window for a non-issuer_down cause', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'insufficient_funds' }),
      context({ downtimeWindow: openWindow }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.recheckOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism and metadata
// ---------------------------------------------------------------------------

describe('determinism and provenance', () => {
  /** Completion criterion 5. */
  it('produces an identical plan twice from the same input', () => {
    const c = planningCase();
    const ctx = context();

    const first = buildPlan(c, ctx, NOW);
    const second = buildPlan(c, ctx, NOW);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.plan.actionType).toBe(first.plan.actionType);
      expect(second.plan.scheduledFor.getTime()).toBe(first.plan.scheduledFor.getTime());
      expect(second.plan.estCostPaise).toBe(first.plan.estCostPaise);
      expect(second.plan.expectedP).toBe(first.plan.expectedP);
      expect(second.plan.rationale).toBe(first.plan.rationale);
    }
  });

  it('stamps the policy version so a decision is reproducible later', () => {
    const outcome = buildPlan(planningCase(), context(), NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.policyVersion).toBe('1.0.0');
  });

  it('records the model version when the LLM was involved', () => {
    const outcome = buildPlan(
      planningCase({ causeBy: 'llm' }),
      context({ modelVersion: 'openai/gpt-oss-120b' }),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.modelVersion).toBe('openai/gpt-oss-120b');
  });

  it('carries a rationale explaining the action and the timing', () => {
    const outcome = buildPlan(planningCase({ rootCause: 'issuer_down' }), context(), NOW);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.rationale).toMatch(/Downtime is usually short/);
      expect(outcome.plan.rationale).toMatch(/Attempt 1\/3/);
    }
  });

  it('only attaches a DLT template to an SMS', () => {
    const sms = buildPlan(
      planningCase({ rootCause: 'overdue_soft', source: 'receivable' }),
      context(),
      NOW,
    );
    expect(sms.ok).toBe(true);
    if (sms.ok) {
      expect(sms.plan.channel).toBe('sms');
      expect(sms.plan.templateId).toBe('DLT_TEST_01');
    }

    const retry = buildPlan(planningCase({ rootCause: 'issuer_down' }), context(), NOW);
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.plan.templateId).toBeNull();
  });

  it('expected value is amount × p − cost, in paise', () => {
    const outcome = buildPlan(
      planningCase({ rootCause: 'overdue_soft', source: 'receivable', amountPaise: 1_000_000 }),
      context(),
      NOW,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // 1,000,000 × 0.4 − 20 = 399,980
      expect(expectedValuePaise(outcome.plan, 1_000_000)).toBe(399_980);
    }
  });
});

describe('interventionForAttempt', () => {
  it('returns null past the max attempts', () => {
    expect(interventionForAttempt('merchant_config_error', 1)).toBeNull();
    expect(interventionForAttempt('invalid_vpa', 2)).toBeNull();
    expect(interventionForAttempt('issuer_down', 3)).toBeNull();
  });

  it('returns null immediately for a terminal cause — nothing to do', () => {
    for (const cause of ['fraud_flag', 'chargeback', 'customer_opt_out'] as const) {
      expect(interventionForAttempt(cause, 1), cause).toBeNull();
    }
  });

  it('clamps a negative or NaN attempt count to the first rung', () => {
    for (const attempt of [-5, Number.NaN]) {
      expect(interventionForAttempt('issuer_down', attempt)?.actionType).toBe('delayed_retry');
    }
  });
});
