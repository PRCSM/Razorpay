/**
 * `runGuardrails` — the ordered chain.
 *
 * ---------------------------------------------------------------------------
 * TWO PROPERTIES, BOTH DELIBERATE
 *
 * **1. Every gate is always evaluated, in the policy.yaml order 0→7.**
 * TASK 4 requires ALL results to persist, passes included. Short-circuiting on the
 * first failure would leave `guardrail_results` a partial record, and "we stopped
 * looking" is not the same evidence as "we checked all eight".
 *
 * **2. The disposition is resolved by SEVERITY, not by position.**
 * A `stop_case` verdict wins absolutely: no gate evaluated after it can turn a
 * terminal case back into an action. This is what makes POLICY_SPEC §5's
 * "ordering is load-bearing" true as a guarantee rather than as a convention —
 * a fraud-flagged, opted-out, or revoked-mandate case cannot be contacted no
 * matter what any other gate said.
 *
 * Resolution precedence, most severe first:
 *   kill_switch → stop_case → drop_and_log → escalate_human
 *   → downgrade_to_non_contact → reschedule (cooling / quiet hours) → allow
 *
 * Reschedules are applied LAST and cumulatively, because a plan can be both too
 * early for the cooling window and inside quiet hours; the later boundary wins.
 * ---------------------------------------------------------------------------
 *
 * TASK 7 — re-entrancy. Pure. No cached state, no hidden clock, no side effects.
 * Callable at planning time and again at execution, and a different `state` may
 * legitimately produce a different verdict. That is the feature: a plan made at
 * 20:00 for 02:00 that actually fires at 09:30 must be re-validated.
 */

import type { ActionType, GateName } from '../types/enums';
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
import type {
  ChainDisposition,
  GatedPlan,
  GateVerdict,
  GuardrailOutcome,
  GuardrailState,
  OnFailAction,
} from './types';

/** The non-contact action a downgraded contact plan becomes. */
const NON_CONTACT_SUBSTITUTE: ActionType = 'delayed_retry';

/** Severity order. Lower index = more severe. */
const SEVERITY: readonly OnFailAction[] = [
  'stop_case',
  'flag_and_skip_llm',
  'drop_and_log',
  'escalate_human',
  'downgrade_to_non_contact',
  'reschedule_to_window_open',
  'reschedule_to_boundary',
];

function severityRank(action: OnFailAction | undefined): number {
  if (action === undefined) return Number.MAX_SAFE_INTEGER;
  const index = SEVERITY.indexOf(action);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function runGuardrails(
  plan: GatedPlan,
  state: GuardrailState,
  policy: PolicyConfig,
  now: Date,
): GuardrailOutcome {
  const results: GateVerdict[] = [];

  /**
   * The global halt, checked before any gate.
   *
   * policy.yaml: "When true, no plan executes. Existing jobs stay queued and drain
   * when it is set back to false." So this stops execution without dropping the
   * plan — the case is not closed, it is held.
   */
  if (policy.kill_switch === true) {
    return {
      results: [
        {
          gate: 'injection_screen',
          passed: false,
          reason: 'kill_switch is engaged in policy.yaml: no plan executes. The plan is held, not dropped.',
          onFail: 'stop_case',
        },
      ],
      disposition: 'stopped',
      plan: null,
      decidedBy: 'kill_switch',
      summary: 'kill_switch engaged — all execution halted globally',
      anyFailedClosed: false,
    };
  }

  // Fail closed on a non-boolean kill switch: an unparseable global halt must halt.
  if (typeof policy.kill_switch !== 'boolean') {
    return {
      results: [],
      disposition: 'stopped',
      plan: null,
      decidedBy: 'kill_switch',
      summary: 'kill_switch in policy.yaml is not a boolean — halting rather than guessing',
      anyFailedClosed: true,
    };
  }

  // ---- evaluate all eight, in order --------------------------------------
  const rescheduleTargets: Date[] = [];

  results.push(gateInjectionScreen(state, policy));
  results.push(gateAttemptCap(state, policy));

  const cooling = gateCoolingWindow(plan, state, policy, now);
  results.push(stripReschedule(cooling));
  if (cooling.rescheduleTo) rescheduleTargets.push(cooling.rescheduleTo);

  results.push(gateContactCap(plan, state, policy));

  const quiet = gateQuietHours(plan, policy);
  results.push(stripReschedule(quiet));
  if (quiet.rescheduleTo) rescheduleTargets.push(quiet.rescheduleTo);

  results.push(gateTerminalCheck(state, policy));
  results.push(gateAmountCeiling(state, policy));
  results.push(gateCompliance(plan, state, policy, now));

  const anyFailedClosed = results.some((r) => r.failedClosed === true);
  const failures = results.filter((r) => !r.passed);

  if (failures.length === 0) {
    return {
      results,
      disposition: 'allow',
      plan,
      decidedBy: null,
      summary: `all ${results.length} gates passed`,
      anyFailedClosed: false,
    };
  }

  // ---- resolve by severity ----------------------------------------------
  const mostSevere = failures.reduce((worst, candidate) =>
    severityRank(candidate.onFail) < severityRank(worst.onFail) ? candidate : worst,
  );

  const decidedBy: GateName = mostSevere.gate;
  const onFail = mostSevere.onFail;

  switch (onFail) {
    case 'stop_case':
    case 'flag_and_skip_llm':
      return {
        results,
        disposition: 'stopped',
        // Nothing executes. The plan is persisted as dropped with every reason.
        plan: null,
        decidedBy,
        summary: `${decidedBy}: ${mostSevere.reason}`,
        anyFailedClosed,
      };

    case 'drop_and_log':
      return {
        results,
        disposition: 'dropped',
        plan: null,
        decidedBy,
        summary: `${decidedBy}: ${mostSevere.reason}`,
        anyFailedClosed,
      };

    case 'escalate_human':
      return {
        results,
        disposition: 'escalated',
        plan: {
          ...plan,
          actionType: 'escalate_human',
          channel: 'none',
          templateId: null,
          isContact: false,
        },
        decidedBy,
        summary: `${decidedBy}: ${mostSevere.reason}`,
        anyFailedClosed,
      };

    case 'downgrade_to_non_contact': {
      const downgraded: GatedPlan = {
        ...plan,
        actionType: NON_CONTACT_SUBSTITUTE,
        channel: 'none',
        templateId: null,
        // Cost drops to zero: a retry is free, the message we did not send is not paid for.
        estCostPaise: 0,
        isContact: false,
      };
      return {
        results,
        disposition: 'downgraded',
        // A downgrade can still be too early, so any reschedule still applies.
        plan: applyReschedules(downgraded, rescheduleTargets),
        decidedBy,
        summary: `${decidedBy}: ${mostSevere.reason}`,
        anyFailedClosed,
      };
    }

    case 'reschedule_to_boundary':
    case 'reschedule_to_window_open':
      return {
        results,
        disposition: 'rescheduled',
        plan: applyReschedules(plan, rescheduleTargets),
        decidedBy,
        summary: `${decidedBy}: ${mostSevere.reason}`,
        anyFailedClosed,
      };

    default:
      /**
       * An unrecognised `on_fail` fails closed. A future policy.yaml could add a
       * disposition this code does not know, and "unknown instruction" must mean
       * "do nothing", never "proceed".
       */
      return {
        results,
        disposition: 'dropped',
        plan: null,
        decidedBy,
        summary:
          `${decidedBy}: unrecognised on_fail "${String(onFail)}" — dropping rather than ` +
          'guessing what policy intended',
        anyFailedClosed: true,
      };
  }
}

/** Push a plan to the latest required boundary. Cumulative, so both gates are honoured. */
function applyReschedules(plan: GatedPlan, targets: readonly Date[]): GatedPlan {
  if (targets.length === 0) return plan;

  const latest = targets.reduce((max, candidate) =>
    candidate.getTime() > max.getTime() ? candidate : max,
  );

  if (latest.getTime() <= plan.scheduledFor.getTime()) return plan;
  return { ...plan, scheduledFor: latest };
}

/** The reschedule target is chain-internal; the persisted verdict is the base shape. */
function stripReschedule(verdict: GateVerdict & { rescheduleTo?: Date }): GateVerdict {
  const { gate, passed, reason, onFail, failedClosed } = verdict;
  return {
    gate,
    passed,
    reason,
    ...(onFail !== undefined ? { onFail } : {}),
    ...(failedClosed !== undefined ? { failedClosed } : {}),
  };
}

/** Did the chain permit anything to execute? */
export function isExecutable(outcome: GuardrailOutcome): boolean {
  return outcome.plan !== null;
}

/**
 * Did the chain permit CONTACT?
 *
 * The property TASK 6 exists to guarantee. A test asserts this is false for every
 * terminal cause, whatever the plan asked for.
 */
export function permitsContact(outcome: GuardrailOutcome): boolean {
  return outcome.plan !== null && outcome.plan.isContact === true;
}

export type { ChainDisposition };
