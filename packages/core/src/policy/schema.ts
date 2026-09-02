/**
 * policy.yaml → a typed, validated `PolicyConfig`. The PURE half.
 *
 * The whole structure is validated, not just the parts currently consumed. A
 * typo in a gate name or a missing threshold must fail at startup, loudly, not
 * silently disable a guardrail at 2am. `.strict()` on every object is what makes
 * that true: an unrecognised key is an error, because a misspelled
 * `max_attemps` that is quietly ignored means the attempt cap does not exist.
 */

import { z } from 'zod';
import { ACTION_TYPES, CONTACT_ACTION_TYPES, TIMING_STRATEGIES } from '../types/enums';

/** Semantic version of the policy document, recorded on every plan. */
const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be semver, e.g. "1.0.0" — it is stamped onto every plan');

/** `"HH:MM"`, 24-hour. */
const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:MM" in 24-hour form, e.g. "21:00"');

/** An IANA timezone name. Kept as a string; resolution happens at the boundary. */
const timezoneSchema = z
  .string()
  .min(1)
  .refine((v) => v.includes('/'), {
    message: 'must be an IANA timezone name, e.g. "Asia/Kolkata"',
  });

const probabilitySchema = z.number().min(0).max(1);

/** Money in policy.yaml is paise, like everywhere else. */
const paiseSchema = z
  .number()
  .int('money must be integer paise, never a float or a rupee value')
  .nonnegative();

const actionTypeSchema = z.enum(ACTION_TYPES);

// ---------------------------------------------------------------------------
// Gates 0–7, in the order the chain evaluates them
// ---------------------------------------------------------------------------

/** Gate 0 — screen untrusted text before it reaches any LLM. */
export const injectionScreenSchema = z
  .object({
    enabled: z.boolean(),
    model: z.string().min(1),
    threshold: probabilitySchema,
    on_detect: z.literal('flag_and_skip_llm'),
  })
  .strict();

/** Gate 1 — hard ceiling on recovery attempts per case. */
export const attemptCapSchema = z
  .object({
    enabled: z.boolean(),
    max_attempts: z.number().int().positive().max(20),
  })
  .strict();

/** Gate 2 — minimum gap between two actions on the same case. */
export const coolingWindowSchema = z
  .object({
    enabled: z.boolean(),
    hours: z.number().nonnegative().max(720),
    on_fail: z.literal('reschedule_to_boundary'),
  })
  .strict();

/** Gate 3 — messages per customer per day, counted ACROSS cases. */
export const contactCapSchema = z
  .object({
    enabled: z.boolean(),
    max_per_customer_per_day: z.number().int().nonnegative().max(50),
    on_fail: z.literal('downgrade_to_non_contact'),
  })
  .strict();

/** Gate 4 — no outreach overnight. Silent actions stay allowed. */
export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    start: timeOfDaySchema,
    end: timeOfDaySchema,
    tz: timezoneSchema,
    applies_to: z.array(actionTypeSchema).min(1),
    on_fail: z.literal('reschedule_to_window_open'),
  })
  .strict()
  .refine((gate) => gate.applies_to.every((a) => CONTACT_ACTION_TYPES.includes(a as never)), {
    message:
      `quiet_hours.applies_to may only contain customer-contacting actions ` +
      `(${CONTACT_ACTION_TYPES.join(', ')}). Silent actions such as retries and payment-link ` +
      `generation are allowed overnight by design.`,
    path: ['applies_to'],
  });

/** Gate 5 — terminal causes stop everything. */
export const terminalCheckSchema = z
  .object({
    enabled: z.boolean(),
    causes: z.array(z.string().min(1)).min(1),
    on_fail: z.literal('stop_case'),
  })
  .strict();

/** Gate 6 — above this amount the agent proposes but does not act. */
export const amountCeilingSchema = z
  .object({
    enabled: z.boolean(),
    max_autonomous_paise: paiseSchema,
    on_fail: z.literal('escalate_human'),
  })
  .strict();

/** Gate 7 — regulatory constraints. */
export const complianceSchema = z
  .object({
    enabled: z.boolean(),
    mandate_requires_pre_debit_notice: z.boolean(),
    pre_debit_notice_lead_hours: z.number().nonnegative().max(720),
    sms_requires_dlt_template_id: z.boolean(),
    on_fail: z.literal('drop_and_log'),
  })
  .strict();

/**
 * The gate block. Every gate is REQUIRED.
 *
 * An absent gate would mean "guardrail silently not present", which is the one
 * failure mode this file exists to prevent. Disabling a gate is done with
 * `enabled: false` — an explicit, visible, auditable statement.
 */
export const gatesSchema = z
  .object({
    injection_screen: injectionScreenSchema,
    attempt_cap: attemptCapSchema,
    cooling_window: coolingWindowSchema,
    contact_cap: contactCapSchema,
    quiet_hours: quietHoursSchema,
    terminal_check: terminalCheckSchema,
    amount_ceiling: amountCeilingSchema,
    compliance: complianceSchema,
  })
  .strict();

/** Rates a real deployment would pay. Stated openly so they can be challenged. */
export const costsSchema = z
  .object({
    sms_paise: paiseSchema,
    whatsapp_paise: paiseSchema,
    human_escalation_paise: paiseSchema,
    retry_paise: paiseSchema,
    payment_link_paise: paiseSchema,
  })
  .strict();

/** A payment inside this window after an action is credited to it. */
export const attributionSchema = z
  .object({
    window_hours: z.number().positive().max(8760),
  })
  .strict();

export const timingSchema = z
  .object({
    strategy: z.enum(TIMING_STRATEGIES),
    bandit_arms_hours: z.array(z.number().positive()).min(1),
    salary_window_days: z.array(z.number().int().min(1).max(28)).min(1),
  })
  .strict()
  .refine(
    (t) => new Set(t.bandit_arms_hours).size === t.bandit_arms_hours.length,
    { message: 'bandit_arms_hours must be distinct', path: ['bandit_arms_hours'] },
  );

/** The whole document. */
export const policyConfigSchema = z
  .object({
    version: versionSchema,
    /** Global halt. When true no plan executes; queued jobs drain once cleared. */
    kill_switch: z.boolean(),
    gates: gatesSchema,
    costs: costsSchema,
    attribution: attributionSchema,
    timing: timingSchema,
  })
  .strict();

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type PolicyGates = z.infer<typeof gatesSchema>;
export type PolicyCosts = z.infer<typeof costsSchema>;
export type PolicyTiming = z.infer<typeof timingSchema>;
export type InjectionScreenGate = z.infer<typeof injectionScreenSchema>;
export type AttemptCapGate = z.infer<typeof attemptCapSchema>;
export type CoolingWindowGate = z.infer<typeof coolingWindowSchema>;
export type ContactCapGate = z.infer<typeof contactCapSchema>;
export type QuietHoursGate = z.infer<typeof quietHoursSchema>;
export type TerminalCheckGate = z.infer<typeof terminalCheckSchema>;
export type AmountCeilingGate = z.infer<typeof amountCeilingSchema>;
export type ComplianceGate = z.infer<typeof complianceSchema>;

/** Thrown when policy.yaml is malformed. Fails loudly, by design. */
export class PolicyValidationError extends Error {
  public readonly issues: readonly { path: string; message: string }[];

  constructor(sourceLabel: string, issues: readonly { path: string; message: string }[]) {
    const lines = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(
      `Invalid policy (${sourceLabel}). ${issues.length} problem(s):\n${lines}\n\n` +
        `The guardrail chain refuses to start on a malformed policy. ` +
        `See docs/POLICY_SPEC.md and policy.yaml.`,
    );
    this.name = 'PolicyValidationError';
    this.issues = issues;
  }
}

/**
 * Validate an already-parsed YAML object into a typed `PolicyConfig`.
 *
 * Pure — takes data, returns data, throws on invalid. The YAML text and the
 * file read happen in `./load.ts`. The eval harness calls this directly with an
 * in-memory object so it can compare alternate policies without touching disk.
 */
export function parsePolicy(raw: unknown, sourceLabel = 'in-memory'): PolicyConfig {
  const result = policyConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.code === 'invalid_type' ? `missing or wrong type — ${issue.message}` : issue.message,
    }));
    throw new PolicyValidationError(sourceLabel, issues);
  }
  return result.data;
}
