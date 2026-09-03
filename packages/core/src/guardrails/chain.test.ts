import { describe, expect, it } from 'vitest';
import { GATE_NAMES } from '../types/enums';
import { parsePolicy, type PolicyConfig } from '../policy/schema';
import { isExecutable, permitsContact, runGuardrails } from './chain';
import type { GatedPlan, GuardrailState } from './types';

/**
 * The chain, and the two properties that make it a guarantee rather than a
 * convention: ORDERING (TASK 6) and RE-ENTRANCY (TASK 7).
 */

const NOW = new Date('2026-02-10T12:00:00.000Z'); // 17:30 IST

function policy(overrides: Record<string, unknown> = {}): PolicyConfig {
  return parsePolicy({
    version: '1.0.0',
    kill_switch: false,
    gates: {
      injection_screen: {
        enabled: true,
        model: 'meta-llama/llama-prompt-guard-2-86m',
        threshold: 0.8,
        on_detect: 'flag_and_skip_llm',
      },
      attempt_cap: { enabled: true, max_attempts: 3 },
      cooling_window: { enabled: true, hours: 4, on_fail: 'reschedule_to_boundary' },
      contact_cap: {
        enabled: true,
        max_per_customer_per_day: 3,
        on_fail: 'downgrade_to_non_contact',
      },
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

function state(overrides: Partial<GuardrailState> = {}): GuardrailState {
  return {
    caseId: 'case-1',
    rootCause: 'insufficient_funds',
    amountPaise: 250_000,
    customerRef: 'cust_0001',
    method: 'card',
    attemptCount: 0,
    lastActionAt: null,
    contactsTodayForCustomer: 0,
    injectionFlagged: false,
    preDebitNoticeSentAt: null,
    isMandateRepresentment: false,
    ...overrides,
  };
}

function plan(overrides: Partial<GatedPlan> = {}): GatedPlan {
  return {
    actionType: 'delayed_retry',
    scheduledFor: new Date('2026-02-10T16:00:00.000Z'),
    channel: 'none',
    templateId: null,
    estCostPaise: 0,
    isContact: false,
    ...overrides,
  };
}

/** A contact plan that would otherwise sail through every gate. */
const validNudge = plan({
  actionType: 'nudge',
  channel: 'sms',
  templateId: 'DLT_VALID_01',
  estCostPaise: 20,
  isContact: true,
  // 17:30 IST — comfortably outside quiet hours.
  scheduledFor: new Date('2026-02-10T12:00:00.000Z'),
});

describe('chain — the happy path', () => {
  it('allows a clean plan and records all eight verdicts', () => {
    const outcome = runGuardrails(plan(), state(), policy(), NOW);

    expect(outcome.disposition).toBe('allow');
    expect(outcome.plan).not.toBeNull();
    expect(outcome.decidedBy).toBeNull();
    expect(outcome.results).toHaveLength(8);
    expect(outcome.results.every((r) => r.passed)).toBe(true);
  });

  /** TASK 4: ALL results persist, passes included, in policy.yaml order. */
  it('records every gate in the policy.yaml order, passes included', () => {
    const outcome = runGuardrails(validNudge, state(), policy(), NOW);
    expect(outcome.results.map((r) => r.gate)).toEqual([...GATE_NAMES]);
  });

  it('records all eight even when a gate fails — never a partial record', () => {
    const outcome = runGuardrails(plan(), state({ rootCause: 'fraud_flag' }), policy(), NOW);
    expect(outcome.results).toHaveLength(8);
    expect(outcome.results.map((r) => r.gate)).toEqual([...GATE_NAMES]);
    // The record shows what passed as well as what stopped it.
    expect(outcome.results.filter((r) => r.passed).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TASK 6 — ORDERING IS LOAD-BEARING
// ---------------------------------------------------------------------------

describe('TASK 6 — a terminal case is NEVER contacted', () => {
  const terminalCauses = ['fraud_flag', 'chargeback', 'customer_opt_out', 'mandate_revoked'];

  for (const rootCause of terminalCauses) {
    it(`${rootCause}: an otherwise-valid nudge produces no contact`, () => {
      const outcome = runGuardrails(validNudge, state({ rootCause }), policy(), NOW);

      // The property, stated three ways.
      expect(permitsContact(outcome)).toBe(false);
      expect(isExecutable(outcome)).toBe(false);
      expect(outcome.plan).toBeNull();

      expect(outcome.disposition).toBe('stopped');
      expect(outcome.decidedBy).toBe('terminal_check');
    });
  }

  /**
   * The decisive case. Every other gate PASSES — the plan is inside the attempt
   * cap, outside the cooling window, under the contact cap, outside quiet hours,
   * under the amount ceiling, and compliant. Only terminal_check objects, and it
   * must still win.
   */
  it('terminal wins even when all seven other gates pass', () => {
    const outcome = runGuardrails(validNudge, state({ rootCause: 'fraud_flag' }), policy(), NOW);

    const others = outcome.results.filter((r) => r.gate !== 'terminal_check');
    expect(others.every((r) => r.passed)).toBe(true);

    expect(outcome.disposition).toBe('stopped');
    expect(permitsContact(outcome)).toBe(false);
  });

  /**
   * Terminal outranks a gate that would merely downgrade or reschedule.
   * If resolution were positional, contact_cap (gate 3) would win over
   * terminal_check (gate 5) and the case would be "downgraded" and still live.
   */
  it('terminal outranks a downgrade from an earlier gate', () => {
    const outcome = runGuardrails(
      validNudge,
      state({ rootCause: 'chargeback', contactsTodayForCustomer: 99 }),
      policy(),
      NOW,
    );
    expect(outcome.disposition).toBe('stopped');
    expect(outcome.decidedBy).toBe('terminal_check');
    expect(outcome.plan).toBeNull();
  });

  it('terminal outranks an escalation from a later gate', () => {
    const outcome = runGuardrails(
      validNudge,
      state({ rootCause: 'fraud_flag', amountPaise: 99_000_000 }),
      policy(),
      NOW,
    );
    expect(outcome.disposition).toBe('stopped');
    expect(outcome.decidedBy).toBe('terminal_check');
  });

  /** Run 3's ambiguity, asserted harmless: both terminal, identical outcome. */
  it('customer_opt_out and mandate_revoked reach the identical outcome', () => {
    const optOut = runGuardrails(validNudge, state({ rootCause: 'customer_opt_out' }), policy(), NOW);
    const revoked = runGuardrails(validNudge, state({ rootCause: 'mandate_revoked' }), policy(), NOW);

    expect(optOut.disposition).toBe(revoked.disposition);
    expect(optOut.decidedBy).toBe(revoked.decidedBy);
    expect(permitsContact(optOut)).toBe(permitsContact(revoked));
    expect(permitsContact(optOut)).toBe(false);
  });

  it('no contact action of any type survives a terminal cause', () => {
    for (const actionType of ['nudge', 'pre_debit_notice', 'promise_to_pay'] as const) {
      const outcome = runGuardrails(
        plan({ actionType, channel: 'sms', templateId: 'DLT_1', isContact: true }),
        state({ rootCause: 'fraud_flag' }),
        policy(),
        NOW,
      );
      expect(permitsContact(outcome), actionType).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

describe('chain — dispositions', () => {
  it('reschedules rather than dropping when only the cooling window objects', () => {
    const outcome = runGuardrails(
      plan({ scheduledFor: new Date('2026-02-10T12:30:00.000Z') }),
      state({ lastActionAt: new Date('2026-02-10T11:00:00.000Z') }),
      policy(),
      NOW,
    );

    expect(outcome.disposition).toBe('rescheduled');
    expect(outcome.plan).not.toBeNull();
    expect(outcome.plan?.scheduledFor.toISOString()).toBe('2026-02-10T15:00:00.000Z');
    // The action itself is unchanged — only its timing moved.
    expect(outcome.plan?.actionType).toBe('delayed_retry');
  });

  it('downgrades a capped contact to a non-contact action, at zero cost', () => {
    const outcome = runGuardrails(
      validNudge,
      state({ contactsTodayForCustomer: 3 }),
      policy(),
      NOW,
    );

    expect(outcome.disposition).toBe('downgraded');
    expect(outcome.plan).not.toBeNull();
    expect(outcome.plan?.isContact).toBe(false);
    expect(outcome.plan?.channel).toBe('none');
    // We are not charged for a message we did not send.
    expect(outcome.plan?.estCostPaise).toBe(0);
    expect(permitsContact(outcome)).toBe(false);
  });

  it('escalates above the amount ceiling rather than acting', () => {
    const outcome = runGuardrails(plan({ scheduledFor: NOW }), state({ amountPaise: 5_000_000 }), policy(), NOW);

    expect(outcome.disposition).toBe('escalated');
    expect(outcome.plan?.actionType).toBe('escalate_human');
    expect(outcome.plan?.isContact).toBe(false);
    expect(outcome.decidedBy).toBe('amount_ceiling');
  });

  it('drops a non-compliant mandate re-presentment and logs it', () => {
    const outcome = runGuardrails(
      plan(),
      state({ isMandateRepresentment: true, preDebitNoticeSentAt: null }),
      policy(),
      NOW,
    );

    expect(outcome.disposition).toBe('dropped');
    expect(outcome.plan).toBeNull();
    expect(outcome.decidedBy).toBe('compliance');
    // Nothing is silently discarded: the reason is in the record.
    expect(outcome.summary).toMatch(/pre-debit notice/);
  });

  it('stops a case at the attempt cap', () => {
    const outcome = runGuardrails(plan(), state({ attemptCount: 3 }), policy(), NOW);
    expect(outcome.disposition).toBe('stopped');
    expect(outcome.decidedBy).toBe('attempt_cap');
  });

  it('blocks an injection-flagged case', () => {
    const outcome = runGuardrails(plan(), state({ injectionFlagged: true }), policy(), NOW);
    expect(outcome.plan).toBeNull();
    expect(outcome.decidedBy).toBe('injection_screen');
  });

  /** Both gates can object at once; the later boundary must win. */
  it('applies the latest boundary when cooling and quiet hours both object', () => {
    const outcome = runGuardrails(
      plan({
        actionType: 'nudge',
        channel: 'sms',
        templateId: 'DLT_1',
        isContact: true,
        // 21:30 IST — inside quiet hours AND inside the cooling window.
        scheduledFor: new Date('2026-02-10T16:00:00.000Z'),
      }),
      state({ lastActionAt: new Date('2026-02-10T15:00:00.000Z') }),
      policy(),
      NOW,
    );

    expect(outcome.plan).not.toBeNull();
    const scheduled = outcome.plan?.scheduledFor.getTime() ?? 0;
    // Cooling boundary is 19:00 UTC; quiet hours reopen at 03:30 UTC next day.
    // The later of the two must be chosen.
    expect(scheduled).toBe(new Date('2026-02-11T03:30:00.000Z').getTime());
  });
});

// ---------------------------------------------------------------------------
// kill_switch
// ---------------------------------------------------------------------------

describe('kill_switch halts everything', () => {
  it('blocks every plan when engaged', () => {
    const halted = policy({ kill_switch: true });

    for (const p of [plan(), validNudge, plan({ actionType: 'immediate_retry' })]) {
      const outcome = runGuardrails(p, state(), halted, NOW);
      expect(outcome.disposition).toBe('stopped');
      expect(outcome.plan).toBeNull();
      expect(outcome.decidedBy).toBe('kill_switch');
      expect(isExecutable(outcome)).toBe(false);
    }
  });

  it('holds the plan rather than dropping it — jobs drain when cleared', () => {
    const outcome = runGuardrails(plan(), state(), policy({ kill_switch: true }), NOW);
    expect(outcome.summary).toMatch(/halted/);
    expect(outcome.results[0]?.reason).toMatch(/held, not dropped/);
  });

  it('halts on a non-boolean kill switch rather than guessing', () => {
    const corrupted = structuredClone(policy()) as PolicyConfig;
    (corrupted as { kill_switch: unknown }).kill_switch = '' as never;

    const outcome = runGuardrails(plan(), state(), corrupted, NOW);
    expect(outcome.disposition).toBe('stopped');
    expect(outcome.anyFailedClosed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK 7 — RE-ENTRANCY
// ---------------------------------------------------------------------------

describe('TASK 7 — re-entrancy', () => {
  it('produces an identical outcome when called twice with the same inputs', () => {
    const p = plan();
    const s = state();
    const pol = policy();

    const first = runGuardrails(p, s, pol, NOW);
    const second = runGuardrails(p, s, pol, NOW);

    expect(second.disposition).toBe(first.disposition);
    expect(second.decidedBy).toBe(first.decidedBy);
    expect(second.summary).toBe(first.summary);
    expect(second.results).toEqual(first.results);
    expect(second.plan?.scheduledFor.getTime()).toBe(first.plan?.scheduledFor.getTime());
  });

  it('does not mutate the plan or the state it was given', () => {
    const p = plan({ actionType: 'nudge', channel: 'sms', templateId: 'DLT_1', isContact: true });
    const s = state({ contactsTodayForCustomer: 3 });
    const frozenPlan = structuredClone(p);
    const frozenState = structuredClone(s);

    runGuardrails(p, s, policy(), NOW);

    expect(p).toEqual(frozenPlan);
    expect(s).toEqual(frozenState);
  });

  /**
   * The re-gating scenario from POLICY_SPEC §5: "A plan made at 20:00 for 02:00
   * that actually fires at 09:30 after a restart must be re-validated." The second
   * call SHOULD disagree, because the state moved on.
   */
  it('reaches a different verdict when the state has changed — the point of re-gating', () => {
    const p = validNudge;
    const pol = policy();

    const atPlanning = runGuardrails(p, state({ contactsTodayForCustomer: 0 }), pol, NOW);
    expect(atPlanning.disposition).toBe('allow');
    expect(permitsContact(atPlanning)).toBe(true);

    // By execution time the customer has hit their daily cap on other cases.
    const atExecution = runGuardrails(p, state({ contactsTodayForCustomer: 3 }), pol, NOW);
    expect(atExecution.disposition).toBe('downgraded');
    expect(permitsContact(atExecution)).toBe(false);
  });

  it('re-gates a case that became terminal between planning and execution', () => {
    const p = validNudge;
    const pol = policy();

    expect(runGuardrails(p, state(), pol, NOW).disposition).toBe('allow');
    // A chargeback arrived in the meantime.
    const after = runGuardrails(p, state({ rootCause: 'chargeback' }), pol, NOW);
    expect(after.disposition).toBe('stopped');
    expect(permitsContact(after)).toBe(false);
  });

  it('is unaffected by call order across different cases', () => {
    const pol = policy();
    const a = state({ caseId: 'a', rootCause: 'fraud_flag' });
    const b = state({ caseId: 'b', rootCause: 'insufficient_funds' });

    const forwards = [runGuardrails(plan(), a, pol, NOW), runGuardrails(plan(), b, pol, NOW)];
    const backwards = [runGuardrails(plan(), b, pol, NOW), runGuardrails(plan(), a, pol, NOW)];

    expect(forwards[0]?.disposition).toBe(backwards[1]?.disposition);
    expect(forwards[1]?.disposition).toBe(backwards[0]?.disposition);
  });

  it('honours the `now` it is given rather than an ambient clock', () => {
    // A nudge at 21:30 IST is blocked; the same plan judged in a different frame
    // still depends only on scheduledFor, so the verdict is stable.
    const nightNudge = plan({
      actionType: 'nudge',
      channel: 'sms',
      templateId: 'DLT_1',
      isContact: true,
      scheduledFor: new Date('2026-02-10T16:00:00.000Z'),
    });

    const early = runGuardrails(nightNudge, state(), policy(), new Date('2026-01-01T00:00:00.000Z'));
    const late = runGuardrails(nightNudge, state(), policy(), new Date('2027-01-01T00:00:00.000Z'));

    expect(early.disposition).toBe(late.disposition);
    expect(early.plan?.scheduledFor.getTime()).toBe(late.plan?.scheduledFor.getTime());
  });
});

describe('chain — fail-closed propagation', () => {
  it('flags anyFailedClosed when a gate blocked on missing data', () => {
    const outcome = runGuardrails(plan(), state({ rootCause: null }), policy(), NOW);
    expect(outcome.anyFailedClosed).toBe(true);
    expect(outcome.plan).toBeNull();
  });

  it('distinguishes a policy refusal from a fail-closed block', () => {
    // An ordinary policy stop: the data was fine, the answer was no.
    const policyStop = runGuardrails(plan(), state({ rootCause: 'fraud_flag' }), policy(), NOW);
    expect(policyStop.disposition).toBe('stopped');
    expect(policyStop.anyFailedClosed).toBe(false);

    // A fail-closed block: the data was missing, so we could not tell.
    const failClosed = runGuardrails(plan(), state({ rootCause: '' }), policy(), NOW);
    expect(failClosed.disposition).toBe('stopped');
    expect(failClosed.anyFailedClosed).toBe(true);
  });
});
