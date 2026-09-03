/**
 * The eight gates, in the order policy.yaml defines them.
 *
 * ---------------------------------------------------------------------------
 * EVERY GATE FAILS CLOSED.
 *
 * TASK 5, and the direct lesson from Run 3: the Prompt Guard bug failed OPEN
 * because `Number('')` is 0, so an empty guard response parsed as "definitely
 * benign" and waved the case through. A security control that treats absent data
 * as permission is not a control.
 *
 * So in this chain a null, empty string, `undefined`, `NaN`, or unparseable
 * threshold BLOCKS the action. Every gate marks that case `failedClosed: true` so
 * it is distinguishable in the audit trail from a normal policy refusal — the two
 * mean different things to an operator.
 *
 * A gate that is `enabled: false` in policy.yaml passes without evaluating. That
 * is an explicit, visible, auditable statement in a version-controlled file, not a
 * silent absence.
 * ---------------------------------------------------------------------------
 */

import { isTerminalCause } from '../diagnose/taxonomy';
import type { GateName } from '../types/enums';
import {
  isWithinDailyWindow,
  istMinutesOfDay,
  nextIstTimeOfDay,
  parseTimeOfDay,
} from '../timing/clock';
import type { PolicyConfig } from '../policy/schema';
import type { GatedPlan, GateVerdict, GuardrailState, OnFailAction } from './types';

/** A finite, non-negative number, or null. The basis of failing closed. */
function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/** A usable Date, or null. Rejects Invalid Date, which is a Date but is NaN. */
function usableDate(value: unknown): Date | null {
  if (!(value instanceof Date)) return null;
  if (Number.isNaN(value.getTime())) return null;
  return value;
}

function pass(gate: GateName, reason: string): GateVerdict {
  return { gate, passed: true, reason };
}

function fail(
  gate: GateName,
  reason: string,
  onFail: OnFailAction,
  failedClosed = false,
): GateVerdict {
  return { gate, passed: false, reason, onFail, failedClosed };
}

// ---------------------------------------------------------------------------
// Gate 0 — injection_screen
// ---------------------------------------------------------------------------

/**
 * Untrusted text was screened before any LLM saw it (Run 3, gate 0 in
 * `packages/llm/guard.ts`). This gate enforces the CONSEQUENCE: a case whose text
 * looked like an injection attempt does not get acted on.
 */
export function gateInjectionScreen(state: GuardrailState, policy: PolicyConfig): GateVerdict {
  const gate: GateName = 'injection_screen';
  const config = policy.gates.injection_screen;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  // Fail closed: a non-boolean flag means we do not know whether the text was
  // screened, and "we do not know" must not mean "proceed".
  if (typeof state.injectionFlagged !== 'boolean') {
    return fail(
      gate,
      'injection flag is missing or not a boolean — cannot confirm the text was screened',
      'flag_and_skip_llm',
      true,
    );
  }

  if (state.injectionFlagged) {
    return fail(
      gate,
      'untrusted text on this case was flagged as a prompt-injection attempt; ' +
        'no LLM call and no action',
      'flag_and_skip_llm',
    );
  }

  return pass(gate, 'untrusted text screened, no injection detected');
}

// ---------------------------------------------------------------------------
// Gate 1 — attempt_cap
// ---------------------------------------------------------------------------

export function gateAttemptCap(state: GuardrailState, policy: PolicyConfig): GateVerdict {
  const gate: GateName = 'attempt_cap';
  const config = policy.gates.attempt_cap;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const max = finiteNonNegative(config.max_attempts);
  if (max === null) {
    return fail(gate, 'max_attempts in policy.yaml is not a usable number', 'stop_case', true);
  }

  const attempts = finiteNonNegative(state.attemptCount);
  if (attempts === null) {
    return fail(
      gate,
      'attempt count is missing or not a number — cannot prove the cap is respected',
      'stop_case',
      true,
    );
  }

  if (attempts >= max) {
    return fail(
      gate,
      `${attempts} attempt(s) already made, cap is ${max}; closing the case as stopped`,
      'stop_case',
    );
  }

  return pass(gate, `attempt ${attempts + 1} of ${max}`);
}

// ---------------------------------------------------------------------------
// Gate 2 — cooling_window
// ---------------------------------------------------------------------------

/**
 * Minimum gap between two actions on the SAME case. Prevents a burst of retries
 * against one customer. On failure the plan is rescheduled to the boundary rather
 * than dropped — the action is still right, just too early.
 */
export function gateCoolingWindow(
  plan: GatedPlan,
  state: GuardrailState,
  policy: PolicyConfig,
  _now: Date,
): GateVerdict & { readonly rescheduleTo?: Date } {
  const gate: GateName = 'cooling_window';
  const config = policy.gates.cooling_window;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const hours = finiteNonNegative(config.hours);
  if (hours === null) {
    return fail(gate, 'cooling_window.hours in policy.yaml is not a usable number', 'stop_case', true);
  }

  // No previous action: nothing to cool down from. This is a pass, not a
  // fail-closed — absence of a prior action is a known state, not missing data.
  const lastAction = usableDate(state.lastActionAt);
  if (state.lastActionAt !== null && lastAction === null) {
    return fail(
      gate,
      'last action timestamp is present but unusable — cannot compute the cooling gap',
      'reschedule_to_boundary',
      true,
    );
  }
  if (lastAction === null) {
    return pass(gate, 'no previous action on this case');
  }

  const scheduledFor = usableDate(plan.scheduledFor);
  if (scheduledFor === null) {
    return fail(gate, 'plan has no usable scheduled_for', 'reschedule_to_boundary', true);
  }

  const boundary = new Date(lastAction.getTime() + hours * 60 * 60 * 1000);
  if (scheduledFor.getTime() < boundary.getTime()) {
    return {
      ...fail(
        gate,
        `scheduled ${scheduledFor.toISOString()} is inside the ${hours}h cooling window ` +
          `after ${lastAction.toISOString()}; rescheduled to ${boundary.toISOString()}`,
        'reschedule_to_boundary',
      ),
      rescheduleTo: boundary,
    };
  }

  return pass(gate, `${hours}h cooling window respected (last action ${lastAction.toISOString()})`);
}

// ---------------------------------------------------------------------------
// Gate 3 — contact_cap
// ---------------------------------------------------------------------------

/**
 * Messages per customer per day, counted ACROSS CASES.
 *
 * The cross-case part is the whole point: a customer with three failed payments
 * must not receive nine messages. Non-contact actions are unaffected, so the
 * failure mode is a downgrade rather than a drop — a retry can still happen.
 */
export function gateContactCap(
  plan: GatedPlan,
  state: GuardrailState,
  policy: PolicyConfig,
): GateVerdict {
  const gate: GateName = 'contact_cap';
  const config = policy.gates.contact_cap;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  if (!plan.isContact) {
    return pass(gate, `${plan.actionType} does not contact the customer`);
  }

  const max = finiteNonNegative(config.max_per_customer_per_day);
  if (max === null) {
    return fail(
      gate,
      'contact_cap.max_per_customer_per_day in policy.yaml is not a usable number',
      'downgrade_to_non_contact',
      true,
    );
  }

  // Fail closed: a contact action with no customer identity cannot be counted
  // against any cap, so it must not be sent.
  const customerRef = typeof state.customerRef === 'string' ? state.customerRef.trim() : '';
  if (customerRef === '') {
    return fail(
      gate,
      'contact action on a case with no customer_ref — the daily cap cannot be enforced',
      'downgrade_to_non_contact',
      true,
    );
  }

  const sent = finiteNonNegative(state.contactsTodayForCustomer);
  if (sent === null) {
    return fail(
      gate,
      "today's contact count for this customer is missing or not a number",
      'downgrade_to_non_contact',
      true,
    );
  }

  if (sent >= max) {
    return fail(
      gate,
      `customer ${customerRef} has already received ${sent} message(s) today across all ` +
        `their cases, cap is ${max}; downgrading to a non-contact action`,
      'downgrade_to_non_contact',
    );
  }

  return pass(gate, `contact ${sent + 1} of ${max} today for ${customerRef}`);
}

// ---------------------------------------------------------------------------
// Gate 4 — quiet_hours
// ---------------------------------------------------------------------------

/**
 * No outreach overnight, in `Asia/Kolkata`. Retries and link generation are silent
 * and remain allowed — the gate only applies to the action types policy.yaml lists.
 */
export function gateQuietHours(
  plan: GatedPlan,
  policy: PolicyConfig,
): GateVerdict & { readonly rescheduleTo?: Date } {
  const gate: GateName = 'quiet_hours';
  const config = policy.gates.quiet_hours;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const applies = config.applies_to.includes(plan.actionType);
  if (!applies) {
    return pass(gate, `${plan.actionType} is silent; quiet hours do not apply`);
  }

  const start = parseTimeOfDay(config.start);
  const end = parseTimeOfDay(config.end);
  // Fail closed: an unparseable boundary must not be read as "no restriction".
  if (start === null || end === null) {
    return fail(
      gate,
      `quiet_hours start/end in policy.yaml are unparseable ("${String(config.start)}" / ` +
        `"${String(config.end)}") — refusing outreach rather than assuming it is allowed`,
      'reschedule_to_window_open',
      true,
    );
  }

  const scheduledFor = usableDate(plan.scheduledFor);
  if (scheduledFor === null) {
    return fail(gate, 'plan has no usable scheduled_for', 'reschedule_to_window_open', true);
  }

  const minutes = istMinutesOfDay(scheduledFor);
  if (isWithinDailyWindow(minutes, start, end)) {
    const reopen = nextIstTimeOfDay(scheduledFor, end);
    return {
      ...fail(
        gate,
        `${plan.actionType} scheduled at ${formatIstMinutes(minutes)} IST, inside quiet hours ` +
          `${config.start}-${config.end} ${config.tz}; rescheduled to ${config.end} IST`,
        'reschedule_to_window_open',
      ),
      rescheduleTo: reopen,
    };
  }

  return pass(
    gate,
    `${plan.actionType} at ${formatIstMinutes(minutes)} IST is outside quiet hours ` +
      `${config.start}-${config.end}`,
  );
}

function formatIstMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Gate 5 — terminal_check
// ---------------------------------------------------------------------------

/**
 * Terminal causes stop everything.
 *
 * POLICY_SPEC §5: "Ordering is load-bearing. Gate 5 runs before gates that could
 * produce contact, so a fraud-flagged case can never be messaged regardless of what
 * came earlier." In this implementation `stop_case` wins absolutely during
 * resolution, so no later gate can turn a terminal case back into an action.
 *
 * The terminal list is read from policy.yaml, with the taxonomy's
 * `isTerminalCause` as a cross-check — if the two disagree, the gate blocks. Two
 * sources of truth agreeing is a guarantee; disagreeing is a reason to stop.
 */
export function gateTerminalCheck(state: GuardrailState, policy: PolicyConfig): GateVerdict {
  const gate: GateName = 'terminal_check';
  const config = policy.gates.terminal_check;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const cause = typeof state.rootCause === 'string' ? state.rootCause.trim() : '';
  // Fail closed: no cause means we cannot prove the case is non-terminal.
  if (cause === '') {
    return fail(
      gate,
      'case has no root_cause — cannot prove it is not terminal, so no action',
      'stop_case',
      true,
    );
  }

  if (!Array.isArray(config.causes) || config.causes.length === 0) {
    return fail(
      gate,
      'terminal_check.causes in policy.yaml is empty or malformed — refusing to act without ' +
        'a terminal list',
      'stop_case',
      true,
    );
  }

  const inPolicy = config.causes.includes(cause);
  const inTaxonomy = isTerminalCause(cause);

  if (inPolicy || inTaxonomy) {
    // Both agree it is terminal, or one of them does. Either way: stop.
    const note = inPolicy === inTaxonomy ? '' : ' (policy.yaml and the taxonomy disagree; stopping is the safe reading)';
    return fail(
      gate,
      `"${cause}" is a terminal cause${note}; the agent stops — no retry, no message`,
      'stop_case',
    );
  }

  return pass(gate, `"${cause}" is not terminal`);
}

// ---------------------------------------------------------------------------
// Gate 6 — amount_ceiling
// ---------------------------------------------------------------------------

/**
 * Above the ceiling the agent proposes but does not act — a human approves.
 * 2,500,000 paise = ₹25,000.
 */
export function gateAmountCeiling(state: GuardrailState, policy: PolicyConfig): GateVerdict {
  const gate: GateName = 'amount_ceiling';
  const config = policy.gates.amount_ceiling;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const ceiling = finiteNonNegative(config.max_autonomous_paise);
  if (ceiling === null) {
    return fail(
      gate,
      'amount_ceiling.max_autonomous_paise in policy.yaml is not a usable integer',
      'escalate_human',
      true,
    );
  }

  const amount = finiteNonNegative(state.amountPaise);
  // Fail closed: an unknown amount cannot be proven to be under the ceiling.
  if (amount === null) {
    return fail(
      gate,
      'case amount is missing or not a number — cannot prove it is under the autonomous ' +
        'ceiling, so a human decides',
      'escalate_human',
      true,
    );
  }
  if (!Number.isInteger(amount)) {
    return fail(
      gate,
      `case amount ${amount} is not an integer number of paise — money must never be a float`,
      'escalate_human',
      true,
    );
  }

  if (amount > ceiling) {
    return fail(
      gate,
      `₹${(amount / 100).toLocaleString('en-IN')} exceeds the ₹${(ceiling / 100).toLocaleString('en-IN')} ` +
        'autonomous ceiling; escalating for human approval',
      'escalate_human',
    );
  }

  return pass(
    gate,
    `₹${(amount / 100).toLocaleString('en-IN')} is within the autonomous ceiling`,
  );
}

// ---------------------------------------------------------------------------
// Gate 7 — compliance
// ---------------------------------------------------------------------------

/**
 * Regulatory constraints: a mandate re-presentment needs prior notice, and an SMS
 * needs a registered DLT template id. Both are legal requirements in India, so the
 * failure mode is `drop_and_log` — an action that cannot be taken lawfully is not
 * rescheduled or downgraded, it is dropped and recorded.
 */
export function gateCompliance(
  plan: GatedPlan,
  state: GuardrailState,
  policy: PolicyConfig,
  now: Date,
): GateVerdict {
  const gate: GateName = 'compliance';
  const config = policy.gates.compliance;

  if (!config.enabled) return pass(gate, 'disabled in policy.yaml');

  const notes: string[] = [];

  // ---- DLT template for SMS ---------------------------------------------
  if (config.sms_requires_dlt_template_id && plan.channel === 'sms') {
    const template = typeof plan.templateId === 'string' ? plan.templateId.trim() : '';
    if (template === '') {
      return fail(
        gate,
        'SMS requires a registered DLT template id and none is set; dropping rather than ' +
          'sending an unregistered message',
        'drop_and_log',
        true,
      );
    }
    notes.push(`DLT template ${template} present`);
  }

  // ---- pre-debit notice before re-presentment ---------------------------
  if (config.mandate_requires_pre_debit_notice && state.isMandateRepresentment) {
    // A pre-debit notice IS the notice; it does not require one itself.
    if (plan.actionType !== 'pre_debit_notice') {
      const leadHours = finiteNonNegative(config.pre_debit_notice_lead_hours);
      if (leadHours === null) {
        return fail(
          gate,
          'compliance.pre_debit_notice_lead_hours in policy.yaml is not a usable number',
          'drop_and_log',
          true,
        );
      }

      const noticeAt = usableDate(state.preDebitNoticeSentAt);
      if (noticeAt === null) {
        return fail(
          gate,
          'mandate re-presentment with no recorded pre-debit notice; regulation requires prior ' +
            'notice, so the plan is dropped and logged',
          'drop_and_log',
          state.preDebitNoticeSentAt !== null,
        );
      }

      const scheduledFor = usableDate(plan.scheduledFor);
      if (scheduledFor === null) {
        return fail(gate, 'plan has no usable scheduled_for', 'drop_and_log', true);
      }

      const earliest = new Date(noticeAt.getTime() + leadHours * 60 * 60 * 1000);
      if (scheduledFor.getTime() < earliest.getTime()) {
        return fail(
          gate,
          `pre-debit notice was sent ${noticeAt.toISOString()} and requires ${leadHours}h lead ` +
            `time, so the earliest lawful re-presentment is ${earliest.toISOString()} — ` +
            `this plan is scheduled ${scheduledFor.toISOString()}`,
          'drop_and_log',
        );
      }
      notes.push(`pre-debit notice ${noticeAt.toISOString()} satisfies ${leadHours}h lead`);
    } else {
      notes.push('this plan IS the pre-debit notice');
    }
  }

  void now;
  return pass(gate, notes.length > 0 ? notes.join('; ') : 'no compliance constraint applies');
}
