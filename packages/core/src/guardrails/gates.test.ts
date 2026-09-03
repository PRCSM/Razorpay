import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../policy/schema';
import type { PolicyConfig } from '../policy/schema';
import {
  gateAmountCeiling,
  gateAttemptCap,
  gateCompliance,
  gateContactCap,
  gateCoolingWindow,
  gateInjectionScreen,
  gateQuietHours,
  gateTerminalCheck,
} from './gates';
import type { GatedPlan, GuardrailState } from './types';

/**
 * Every gate, pass and fail — and then every gate fed hostile input.
 *
 * The hostile-input block is TASK 5, and it is the most important set of
 * assertions in this file. Run 3's Prompt Guard bug failed OPEN because
 * `Number('')` is 0, so an empty response read as "definitely benign". These tests
 * exist so that class of bug cannot recur silently in the money path.
 */

const NOW = new Date('2026-02-10T12:00:00.000Z'); // 17:30 IST — outside quiet hours

function policy(overrides: Record<string, unknown> = {}): PolicyConfig {
  const base = {
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
  };
  return parsePolicy(base, 'test');
}

/** A policy with a deliberately corrupted field, bypassing Zod. */
function corruptPolicy(mutate: (p: PolicyConfig) => void): PolicyConfig {
  const p = structuredClone(policy()) as PolicyConfig;
  mutate(p);
  return p;
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

// ---------------------------------------------------------------------------
// Gate 0 — injection_screen
// ---------------------------------------------------------------------------

describe('gate 0 — injection_screen', () => {
  it('passes when the text was screened clean', () => {
    const v = gateInjectionScreen(state(), policy());
    expect(v.passed).toBe(true);
  });

  it('blocks a flagged case and skips the LLM', () => {
    const v = gateInjectionScreen(state({ injectionFlagged: true }), policy());
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('flag_and_skip_llm');
    expect(v.reason).toMatch(/injection/);
  });

  it('passes when disabled in policy', () => {
    const p = policy({
      gates: { ...policy().gates, injection_screen: { ...policy().gates.injection_screen, enabled: false } },
    });
    expect(gateInjectionScreen(state({ injectionFlagged: true }), p).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 1 — attempt_cap
// ---------------------------------------------------------------------------

describe('gate 1 — attempt_cap', () => {
  it('allows attempts below the cap', () => {
    for (const attemptCount of [0, 1, 2]) {
      expect(gateAttemptCap(state({ attemptCount }), policy()).passed).toBe(true);
    }
  });

  it('blocks at and above the cap, stopping the case', () => {
    for (const attemptCount of [3, 4, 99]) {
      const v = gateAttemptCap(state({ attemptCount }), policy());
      expect(v.passed).toBe(false);
      expect(v.onFail).toBe('stop_case');
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — cooling_window
// ---------------------------------------------------------------------------

describe('gate 2 — cooling_window', () => {
  it('passes when there is no previous action', () => {
    expect(gateCoolingWindow(plan(), state(), policy(), NOW).passed).toBe(true);
  });

  it('passes when the gap is respected', () => {
    const v = gateCoolingWindow(
      plan({ scheduledFor: new Date('2026-02-10T16:00:00.000Z') }),
      state({ lastActionAt: new Date('2026-02-10T11:00:00.000Z') }),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(true);
  });

  /** RESCHEDULES rather than dropping: the action is right, just too early. */
  it('reschedules to the boundary rather than dropping', () => {
    const lastActionAt = new Date('2026-02-10T11:00:00.000Z');
    const v = gateCoolingWindow(
      plan({ scheduledFor: new Date('2026-02-10T12:30:00.000Z') }),
      state({ lastActionAt }),
      policy(),
      NOW,
    );

    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('reschedule_to_boundary');
    // 11:00 + 4h = 15:00
    expect(v.rescheduleTo?.toISOString()).toBe('2026-02-10T15:00:00.000Z');
  });

  it('treats the boundary itself as inside the window', () => {
    const lastActionAt = new Date('2026-02-10T11:00:00.000Z');
    const atBoundary = gateCoolingWindow(
      plan({ scheduledFor: new Date('2026-02-10T15:00:00.000Z') }),
      state({ lastActionAt }),
      policy(),
      NOW,
    );
    expect(atBoundary.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — contact_cap
// ---------------------------------------------------------------------------

describe('gate 3 — contact_cap', () => {
  const contactPlan = plan({ actionType: 'nudge', channel: 'sms', isContact: true });

  it('ignores non-contact actions entirely', () => {
    const v = gateContactCap(plan(), state({ contactsTodayForCustomer: 99 }), policy());
    expect(v.passed).toBe(true);
  });

  it('allows contacts below the cap', () => {
    for (const sent of [0, 1, 2]) {
      expect(
        gateContactCap(contactPlan, state({ contactsTodayForCustomer: sent }), policy()).passed,
      ).toBe(true);
    }
  });

  /**
   * The cross-case property. policy.yaml: "A customer with three failed payments
   * must not receive nine messages." The count is per CUSTOMER, not per case.
   */
  it('counts ACROSS cases for one customer and downgrades at the cap', () => {
    const v = gateContactCap(
      contactPlan,
      // This is a different case, but the same customer already had 3 today.
      state({ caseId: 'a-different-case', contactsTodayForCustomer: 3 }),
      policy(),
    );
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('downgrade_to_non_contact');
    expect(v.reason).toMatch(/across all/);
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — quiet_hours
// ---------------------------------------------------------------------------

describe('gate 4 — quiet_hours, Asia/Kolkata', () => {
  const nudge = (iso: string): GatedPlan =>
    plan({ actionType: 'nudge', channel: 'sms', isContact: true, scheduledFor: new Date(iso) });

  /** 20:59 IST = 15:29 UTC. Just before quiet hours begin. */
  it('allows outreach at 20:59 IST', () => {
    const v = gateQuietHours(nudge('2026-02-10T15:29:00.000Z'), policy());
    expect(v.passed).toBe(true);
    expect(v.reason).toMatch(/20:59/);
  });

  /** 21:01 IST = 15:31 UTC. Just inside. */
  it('blocks outreach at 21:01 IST and reschedules to 09:00', () => {
    const v = gateQuietHours(nudge('2026-02-10T15:31:00.000Z'), policy());
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('reschedule_to_window_open');
    expect(v.reason).toMatch(/21:01/);
    // 09:00 IST the next morning = 03:30 UTC on the 11th.
    expect(v.rescheduleTo?.toISOString()).toBe('2026-02-11T03:30:00.000Z');
  });

  it('blocks across the whole night', () => {
    // 21:00, 00:00, 03:00, 08:59 IST
    for (const iso of [
      '2026-02-10T15:30:00.000Z',
      '2026-02-10T18:30:00.000Z',
      '2026-02-10T21:30:00.000Z',
      '2026-02-11T03:29:00.000Z',
    ]) {
      expect(gateQuietHours(nudge(iso), policy()).passed, iso).toBe(false);
    }
  });

  it('allows outreach at exactly 09:00 IST', () => {
    // 09:00 IST = 03:30 UTC
    expect(gateQuietHours(nudge('2026-02-11T03:30:00.000Z'), policy()).passed).toBe(true);
  });

  /** Retries and links are silent, so they run overnight by design. */
  it('does not apply to silent actions', () => {
    for (const actionType of ['delayed_retry', 'immediate_retry', 'payment_link', 'method_switch'] as const) {
      const v = gateQuietHours(
        plan({ actionType, scheduledFor: new Date('2026-02-10T18:30:00.000Z') }),
        policy(),
      );
      expect(v.passed, actionType).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate 5 — terminal_check
// ---------------------------------------------------------------------------

describe('gate 5 — terminal_check', () => {
  it('passes a non-terminal cause', () => {
    expect(gateTerminalCheck(state({ rootCause: 'insufficient_funds' }), policy()).passed).toBe(true);
  });

  it('stops every terminal cause', () => {
    for (const rootCause of ['fraud_flag', 'chargeback', 'customer_opt_out', 'mandate_revoked']) {
      const v = gateTerminalCheck(state({ rootCause }), policy());
      expect(v.passed, rootCause).toBe(false);
      expect(v.onFail).toBe('stop_case');
    }
  });

  /**
   * Run 3 found that `customer_opt_out` and `mandate_revoked` are
   * indistinguishable on a mandate rail. Both are terminal, so the outcome is
   * identical — asserted explicitly here so the confusion stays harmless.
   */
  it('treats customer_opt_out and mandate_revoked identically', () => {
    const optOut = gateTerminalCheck(state({ rootCause: 'customer_opt_out' }), policy());
    const revoked = gateTerminalCheck(state({ rootCause: 'mandate_revoked' }), policy());

    expect(optOut.passed).toBe(revoked.passed);
    expect(optOut.onFail).toBe(revoked.onFail);
    expect(optOut.passed).toBe(false);
    expect(optOut.onFail).toBe('stop_case');
  });
});

// ---------------------------------------------------------------------------
// Gate 6 — amount_ceiling
// ---------------------------------------------------------------------------

describe('gate 6 — amount_ceiling', () => {
  it('allows an amount at or under ₹25,000', () => {
    for (const amountPaise of [0, 100, 2_499_999, 2_500_000]) {
      expect(gateAmountCeiling(state({ amountPaise }), policy()).passed, String(amountPaise)).toBe(
        true,
      );
    }
  });

  /** ESCALATES rather than acting — the agent proposes, a human approves. */
  it('escalates above the ceiling instead of acting', () => {
    const v = gateAmountCeiling(state({ amountPaise: 2_500_001 }), policy());
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('escalate_human');
    expect(v.reason).toMatch(/ceiling/);
  });

  it('refuses a fractional amount — money is never a float', () => {
    const v = gateAmountCeiling(state({ amountPaise: 1000.5 }), policy());
    expect(v.passed).toBe(false);
    expect(v.failedClosed).toBe(true);
    expect(v.reason).toMatch(/integer/);
  });
});

// ---------------------------------------------------------------------------
// Gate 7 — compliance
// ---------------------------------------------------------------------------

describe('gate 7 — compliance', () => {
  it('passes when nothing applies', () => {
    expect(gateCompliance(plan(), state(), policy(), NOW).passed).toBe(true);
  });

  it('allows an SMS with a DLT template id', () => {
    const v = gateCompliance(
      plan({ actionType: 'nudge', channel: 'sms', templateId: 'DLT_123', isContact: true }),
      state(),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(true);
  });

  it('drops an SMS with no DLT template id', () => {
    const v = gateCompliance(
      plan({ actionType: 'nudge', channel: 'sms', templateId: null, isContact: true }),
      state(),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('drop_and_log');
    expect(v.reason).toMatch(/DLT/);
  });

  /** The headline compliance rule: notice before re-presentment. */
  it('blocks a mandate re-presentment with NO prior notice', () => {
    const v = gateCompliance(
      plan({ actionType: 'delayed_retry' }),
      state({ isMandateRepresentment: true, preDebitNoticeSentAt: null }),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(false);
    expect(v.onFail).toBe('drop_and_log');
    expect(v.reason).toMatch(/pre-debit notice/);
  });

  it('blocks a re-presentment inside the 24h notice lead time', () => {
    const v = gateCompliance(
      plan({ actionType: 'delayed_retry', scheduledFor: new Date('2026-02-10T20:00:00.000Z') }),
      state({
        isMandateRepresentment: true,
        // Only 8 hours before the scheduled debit.
        preDebitNoticeSentAt: new Date('2026-02-10T12:00:00.000Z'),
      }),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/24h lead/);
  });

  it('allows a re-presentment once the lead time has elapsed', () => {
    const v = gateCompliance(
      plan({ actionType: 'delayed_retry', scheduledFor: new Date('2026-02-12T12:00:00.000Z') }),
      state({
        isMandateRepresentment: true,
        preDebitNoticeSentAt: new Date('2026-02-10T12:00:00.000Z'),
      }),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(true);
  });

  /** The notice itself cannot require a prior notice. */
  it('never blocks the pre-debit notice on the absence of a pre-debit notice', () => {
    const v = gateCompliance(
      plan({ actionType: 'pre_debit_notice', channel: 'sms', templateId: 'DLT_1', isContact: true }),
      state({ isMandateRepresentment: true, preDebitNoticeSentAt: null }),
      policy(),
      NOW,
    );
    expect(v.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK 5 — EVERY GATE FAILS CLOSED
// ---------------------------------------------------------------------------

/**
 * The hostile-input matrix.
 *
 * Every gate is fed empty string, null, undefined, and NaN in the field it depends
 * on, and must BLOCK in every case. A gate that passes on absent data is the bug
 * Run 3 shipped and this run exists to prevent.
 *
 * `as never` casts are deliberate: these are values the type system forbids and
 * that a database, a JSON payload, or a hand-edited policy.yaml can still deliver.
 */
describe('TASK 5 — every gate fails CLOSED on empty/null/undefined/NaN', () => {
  const hostile = [
    { label: 'empty string', value: '' as never },
    { label: 'null', value: null as never },
    { label: 'undefined', value: undefined as never },
    { label: 'NaN', value: Number.NaN as never },
  ];

  describe('gate 0 — injection flag', () => {
    for (const { label, value } of hostile) {
      it(`blocks on ${label}`, () => {
        const v = gateInjectionScreen(state({ injectionFlagged: value }), policy());
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      });
    }
  });

  describe('gate 1 — attempt count', () => {
    for (const { label, value } of hostile) {
      it(`blocks on ${label}`, () => {
        const v = gateAttemptCap(state({ attemptCount: value }), policy());
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
        expect(v.onFail).toBe('stop_case');
      });
    }

    it('blocks on a malformed max_attempts in policy', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.attempt_cap as { max_attempts: number }).max_attempts = value;
        });
        const v = gateAttemptCap(state(), p);
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      }
    });
  });

  describe('gate 2 — cooling window', () => {
    it('blocks on a present-but-unusable last action timestamp', () => {
      for (const value of ['' as never, Number.NaN as never, new Date('nope') as never]) {
        const v = gateCoolingWindow(plan(), state({ lastActionAt: value }), policy(), NOW);
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      }
    });

    it('blocks on an unusable scheduled_for', () => {
      const v = gateCoolingWindow(
        plan({ scheduledFor: new Date('invalid') }),
        state({ lastActionAt: new Date('2026-02-10T11:00:00.000Z') }),
        policy(),
        NOW,
      );
      expect(v.passed).toBe(false);
      expect(v.failedClosed).toBe(true);
    });

    it('blocks on a malformed cooling_window.hours', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.cooling_window as { hours: number }).hours = value;
        });
        const v = gateCoolingWindow(plan(), state(), p, NOW);
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      }
    });
  });

  describe('gate 3 — contact cap', () => {
    const contactPlan = plan({ actionType: 'nudge', channel: 'sms', isContact: true });

    for (const { label, value } of hostile) {
      it(`blocks a contact action on ${label} customer_ref`, () => {
        const v = gateContactCap(contactPlan, state({ customerRef: value }), policy());
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      });

      it(`blocks a contact action on ${label} contact count`, () => {
        const v = gateContactCap(
          contactPlan,
          state({ contactsTodayForCustomer: value }),
          policy(),
        );
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
      });
    }

    it('blocks on a malformed max_per_customer_per_day', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.contact_cap as { max_per_customer_per_day: number }).max_per_customer_per_day =
            value;
        });
        expect(gateContactCap(contactPlan, state(), p).passed).toBe(false);
      }
    });
  });

  describe('gate 4 — quiet hours', () => {
    const nudge = plan({ actionType: 'nudge', channel: 'sms', isContact: true });

    it('blocks on unparseable start/end boundaries', () => {
      for (const { label, value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.quiet_hours as { start: string }).start = value;
        });
        const v = gateQuietHours(nudge, p);
        expect(v.passed, label).toBe(false);
        expect(v.failedClosed).toBe(true);
        // The critical wording: refuses rather than assuming outreach is allowed.
        expect(v.reason).toMatch(/refusing outreach/);
      }
    });

    it('blocks on a nonsense time string, not just an empty one', () => {
      for (const bad of ['9pm', '25:00', '21:60', 'midnight', '2100']) {
        const p = corruptPolicy((c) => {
          (c.gates.quiet_hours as { start: string }).start = bad;
        });
        expect(gateQuietHours(nudge, p).passed, bad).toBe(false);
      }
    });

    it('blocks on an unusable scheduled_for', () => {
      const v = gateQuietHours(
        plan({ actionType: 'nudge', isContact: true, scheduledFor: new Date('invalid') }),
        policy(),
      );
      expect(v.passed).toBe(false);
      expect(v.failedClosed).toBe(true);
    });
  });

  describe('gate 5 — terminal check', () => {
    for (const { label, value } of hostile) {
      it(`blocks on ${label} root_cause — cannot prove it is not terminal`, () => {
        const v = gateTerminalCheck(state({ rootCause: value }), policy());
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
        expect(v.onFail).toBe('stop_case');
      });
    }

    it('blocks on an empty terminal list', () => {
      const p = corruptPolicy((c) => {
        (c.gates.terminal_check as { causes: string[] }).causes = [];
      });
      const v = gateTerminalCheck(state(), p);
      expect(v.passed).toBe(false);
      expect(v.failedClosed).toBe(true);
    });

    it('blocks on a malformed terminal list', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.terminal_check as { causes: string[] }).causes = value;
        });
        expect(gateTerminalCheck(state(), p).passed).toBe(false);
      }
    });
  });

  describe('gate 6 — amount ceiling', () => {
    for (const { label, value } of hostile) {
      it(`blocks on ${label} amount`, () => {
        const v = gateAmountCeiling(state({ amountPaise: value }), policy());
        expect(v.passed).toBe(false);
        expect(v.failedClosed).toBe(true);
        expect(v.onFail).toBe('escalate_human');
      });
    }

    it('blocks on a negative amount', () => {
      expect(gateAmountCeiling(state({ amountPaise: -1 }), policy()).passed).toBe(false);
    });

    it('blocks on a malformed ceiling in policy', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.amount_ceiling as { max_autonomous_paise: number }).max_autonomous_paise = value;
        });
        expect(gateAmountCeiling(state(), p).passed).toBe(false);
      }
    });

    it('blocks on Infinity', () => {
      expect(
        gateAmountCeiling(state({ amountPaise: Number.POSITIVE_INFINITY }), policy()).passed,
      ).toBe(false);
    });
  });

  describe('gate 7 — compliance', () => {
    for (const { label, value } of hostile) {
      it(`blocks an SMS on ${label} template id`, () => {
        const v = gateCompliance(
          plan({ actionType: 'nudge', channel: 'sms', templateId: value, isContact: true }),
          state(),
          policy(),
          NOW,
        );
        expect(v.passed).toBe(false);
        expect(v.onFail).toBe('drop_and_log');
      });

      it(`blocks a mandate re-presentment on ${label} notice timestamp`, () => {
        const v = gateCompliance(
          plan({ actionType: 'delayed_retry' }),
          state({ isMandateRepresentment: true, preDebitNoticeSentAt: value }),
          policy(),
          NOW,
        );
        expect(v.passed).toBe(false);
        expect(v.onFail).toBe('drop_and_log');
      });
    }

    it('blocks a whitespace-only DLT template id', () => {
      const v = gateCompliance(
        plan({ actionType: 'nudge', channel: 'sms', templateId: '   ', isContact: true }),
        state(),
        policy(),
        NOW,
      );
      expect(v.passed).toBe(false);
    });

    it('blocks on a malformed lead time in policy', () => {
      for (const { value } of hostile) {
        const p = corruptPolicy((c) => {
          (c.gates.compliance as { pre_debit_notice_lead_hours: number }).pre_debit_notice_lead_hours =
            value;
        });
        const v = gateCompliance(
          plan({ actionType: 'delayed_retry' }),
          state({
            isMandateRepresentment: true,
            preDebitNoticeSentAt: new Date('2026-02-01T00:00:00.000Z'),
          }),
          p,
          NOW,
        );
        expect(v.passed).toBe(false);
      }
    });
  });
});
