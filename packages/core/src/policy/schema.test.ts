import { describe, expect, it } from 'vitest';
import { parsePolicy, PolicyValidationError } from './schema.js';

/**
 * A malformed policy must fail loudly. The failure mode this guards against is
 * subtler than a crash: a misspelled key that is silently ignored means a
 * guardrail quietly does not exist, while the dashboard still claims it does.
 */
function validPolicy(): Record<string, unknown> {
  return {
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
    timing: {
      strategy: 'static',
      bandit_arms_hours: [2, 6, 18, 48],
      salary_window_days: [1, 2, 3],
    },
  };
}

describe('parsePolicy — happy path', () => {
  it('accepts a well-formed policy and types it', () => {
    const policy = parsePolicy(validPolicy(), 'test');
    expect(policy.version).toBe('1.0.0');
    expect(policy.kill_switch).toBe(false);
    expect(policy.gates.attempt_cap.max_attempts).toBe(3);
    expect(policy.gates.amount_ceiling.max_autonomous_paise).toBe(2_500_000);
    expect(policy.attribution.window_hours).toBe(72);
  });

  it('exposes all eight gates', () => {
    const policy = parsePolicy(validPolicy(), 'test');
    expect(Object.keys(policy.gates)).toHaveLength(8);
  });
});

describe('parsePolicy — every gate is mandatory', () => {
  const gateNames = [
    'injection_screen',
    'attempt_cap',
    'cooling_window',
    'contact_cap',
    'quiet_hours',
    'terminal_check',
    'amount_ceiling',
    'compliance',
  ] as const;

  for (const gate of gateNames) {
    it(`rejects a policy missing the ${gate} gate`, () => {
      const doc = validPolicy();
      delete (doc['gates'] as Record<string, unknown>)[gate];
      expect(() => parsePolicy(doc, 'test')).toThrow(PolicyValidationError);
      try {
        parsePolicy(doc, 'test');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as PolicyValidationError).message).toContain(gate);
      }
    });
  }
});

describe('parsePolicy — a typo cannot silently disable a guardrail', () => {
  it('rejects an unrecognised key inside a gate', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const cap = gates['attempt_cap'];
    if (!cap) throw new Error('fixture broken');
    delete cap['max_attempts'];
    cap['max_attemps'] = 3; // deliberate typo
    expect(() => parsePolicy(doc, 'test')).toThrow(PolicyValidationError);
  });

  it('rejects an unrecognised top-level key', () => {
    const doc = validPolicy();
    doc['unexpected_section'] = { foo: 'bar' };
    expect(() => parsePolicy(doc, 'test')).toThrow(PolicyValidationError);
  });
});

describe('parsePolicy — field rules', () => {
  it('requires a semver version', () => {
    const doc = validPolicy();
    doc['version'] = 'v1';
    expect(() => parsePolicy(doc, 'test')).toThrow(/version/);
  });

  it('requires quiet hours to be HH:MM', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const quiet = gates['quiet_hours'];
    if (!quiet) throw new Error('fixture broken');
    quiet['start'] = '9pm';
    expect(() => parsePolicy(doc, 'test')).toThrow(/quiet_hours/);
  });

  it('requires an IANA timezone', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const quiet = gates['quiet_hours'];
    if (!quiet) throw new Error('fixture broken');
    quiet['tz'] = 'IST';
    expect(() => parsePolicy(doc, 'test')).toThrow(/quiet_hours/);
  });

  it('refuses to apply quiet hours to a silent action', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const quiet = gates['quiet_hours'];
    if (!quiet) throw new Error('fixture broken');
    // Retries are silent and must stay allowed overnight.
    quiet['applies_to'] = ['nudge', 'delayed_retry'];
    expect(() => parsePolicy(doc, 'test')).toThrow(/applies_to/);
  });

  it('rejects a fractional money amount', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const ceiling = gates['amount_ceiling'];
    if (!ceiling) throw new Error('fixture broken');
    ceiling['max_autonomous_paise'] = 2_500_000.5;
    expect(() => parsePolicy(doc, 'test')).toThrow(/integer paise/);
  });

  it('rejects a threshold outside 0..1', () => {
    const doc = validPolicy();
    const gates = doc['gates'] as Record<string, Record<string, unknown>>;
    const screen = gates['injection_screen'];
    if (!screen) throw new Error('fixture broken');
    screen['threshold'] = 1.5;
    expect(() => parsePolicy(doc, 'test')).toThrow(PolicyValidationError);
  });

  it('rejects duplicate bandit arms', () => {
    const doc = validPolicy();
    const timing = doc['timing'] as Record<string, unknown>;
    timing['bandit_arms_hours'] = [2, 2, 6];
    expect(() => parsePolicy(doc, 'test')).toThrow(/bandit_arms_hours/);
  });

  it('rejects an unknown timing strategy', () => {
    const doc = validPolicy();
    const timing = doc['timing'] as Record<string, unknown>;
    timing['strategy'] = 'vibes';
    expect(() => parsePolicy(doc, 'test')).toThrow(PolicyValidationError);
  });

  it('rejects a non-object document', () => {
    expect(() => parsePolicy(null, 'test')).toThrow(PolicyValidationError);
    expect(() => parsePolicy('a string', 'test')).toThrow(PolicyValidationError);
  });
});
