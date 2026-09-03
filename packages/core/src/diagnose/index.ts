/**
 * Diagnosis: every case gets a root cause, or an honest `unknown`.
 *
 * Precedence, and the order is the whole design:
 *
 *   1. DOWNTIME SIGNAL  — Razorpay told us the issuer was down. Observed fact.
 *   2. RULE TABLE       — deterministic tuple match. The default path.
 *   3. LLM TAIL         — only for tuples the table does not cover.
 *   4. UNKNOWN          — admitted failure, routed to the exception list.
 *
 * docs/POLICY_SPEC.md §6: "The rule engine decides. The LLM explains and handles
 * the tail." If the LLM is resolving most cases the rule table is too thin, and
 * that is reported rather than hidden — `summariseDiagnoses` exists to make the
 * split impossible to look away from.
 *
 * PURE. The clock and the LLM both arrive as parameters.
 */

import type { CaseSource, CauseSource } from '../types/enums';
import { findActiveDowntime, type DowntimeWindow } from './downtime';
import type { DiagnosisTailPort, TailFailureReason } from './port';
import { applyRuleTable, parseDaysOverdue, type DiagnosisInput } from './rules';
import { isCauseValidForSource, causesForSource, type DiagnosedCause } from './taxonomy';

/** Confidence below which an LLM verdict is discarded. From TASK 4. */
export const MIN_LLM_CONFIDENCE = 0.7;

/** A completed diagnosis, ready to write onto `recovery_cases`. */
export interface Diagnosis {
  readonly cause: DiagnosedCause;
  /** 1.0 for downtime and rules — both are deterministic. */
  readonly confidence: number;
  readonly causeBy: CauseSource;
  /** Rule id, downtime window id, or the model that answered. For the audit log. */
  readonly evidence: string;
  /** Present only for an LLM verdict. */
  readonly reasoning: string | null;
  /** Set when the case must go to the exception list instead of a plan. */
  readonly exceptionReason: string | null;
  /** True when the first LLM response failed Zod and the retry was consumed. */
  readonly parseRetried: boolean;
  /** True when the LLM answered from cache. */
  readonly cached: boolean;
}

export interface DiagnoseArgs {
  readonly input: DiagnosisInput;
  /** When the failure happened. Used for downtime matching. */
  readonly failedAt: Date;
  /** Active and historical downtime windows. Empty in the synthetic lane. */
  readonly downtimeWindows?: readonly DowntimeWindow[];
  /** Omit to run rules-only — used by the scoring harness. */
  readonly tail?: DiagnosisTailPort;
}

function unknownDiagnosis(
  reason: TailFailureReason | 'no_rule_match_no_tail',
  detail: string,
  extras: { parseRetried?: boolean; cached?: boolean } = {},
): Diagnosis {
  return {
    cause: 'unknown',
    confidence: 0,
    // `unknown` from a rules-only run is still a rule-path outcome: the table
    // was applied and produced nothing.
    causeBy: 'rule',
    evidence: reason,
    reasoning: null,
    exceptionReason: `${reason}: ${detail}`,
    parseRetried: extras.parseRetried ?? false,
    cached: extras.cached ?? false,
  };
}

/**
 * Diagnose one case.
 *
 * Never throws. A failure of any path degrades to `unknown` with a recorded
 * reason, because a crash here would stall the whole diagnosis queue.
 */
export async function diagnoseCase(args: DiagnoseArgs): Promise<Diagnosis> {
  const { input, failedAt, downtimeWindows = [], tail } = args;

  // ---- 1. Downtime signal -------------------------------------------------
  // Only meaningful for rails Razorpay reports downtime on. A confirmed outage
  // outranks the rule table: it is observation, not inference.
  if (input.source === 'payment' || input.source === 'mandate') {
    const window = findActiveDowntime(
      { issuer: input.issuer, method: input.method, at: failedAt },
      downtimeWindows,
    );
    if (window) {
      return {
        cause: 'issuer_down',
        confidence: 1,
        causeBy: 'downtime_signal',
        evidence: `downtime_window:${window.id ?? 'unpersisted'}:${window.issuer ?? 'any'}:${
          window.method ?? 'any'
        }`,
        reasoning: null,
        exceptionReason: null,
        parseRetried: false,
        cached: false,
      };
    }
  }

  // ---- 2. Rule table ------------------------------------------------------
  const enriched: DiagnosisInput =
    input.source === 'receivable' && input.daysOverdue === null
      ? { ...input, daysOverdue: parseDaysOverdue(input.errorReason) }
      : input;

  const match = applyRuleTable(enriched);
  if (match) {
    return {
      cause: match.cause,
      confidence: 1,
      causeBy: 'rule',
      evidence: `rule:${match.ruleId}`,
      reasoning: null,
      exceptionReason: null,
      parseRetried: false,
      cached: false,
    };
  }

  // ---- 3. LLM tail --------------------------------------------------------
  if (!tail) {
    return unknownDiagnosis(
      'no_rule_match_no_tail',
      'no rule matched and no LLM tail was provided',
    );
  }

  const outcome = await tail.diagnose({
    source: input.source,
    errorCode: input.errorCode,
    errorSource: input.errorSource,
    errorStep: input.errorStep,
    errorReason: input.errorReason,
    method: input.method,
    issuer: input.issuer,
    allowedCauses: causesForSource(input.source),
  });

  if (!outcome.ok) {
    return unknownDiagnosis(outcome.reason, outcome.detail, { parseRetried: outcome.retried });
  }

  const verdict = outcome.verdict;

  // The LLM said `unknown` itself. An honest abstention, kept as one.
  if (verdict.cause === 'unknown') {
    return {
      cause: 'unknown',
      confidence: verdict.confidence,
      causeBy: 'llm',
      evidence: `model:${verdict.model}`,
      reasoning: verdict.reasoning,
      exceptionReason: 'llm_abstained: model returned unknown',
      parseRetried: verdict.retried,
      cached: verdict.cached,
    };
  }

  // Belt and braces: the port validates, and core checks again. A cause on the
  // wrong surface (invalid_vpa for an invoice) is rejected outright.
  if (!isCauseValidForSource(verdict.cause, input.source)) {
    return {
      cause: 'unknown',
      confidence: 0,
      causeBy: 'llm',
      evidence: `model:${verdict.model}`,
      reasoning: verdict.reasoning,
      exceptionReason: `invalid_response: "${verdict.cause}" is not a legal cause for source "${input.source}"`,
      parseRetried: verdict.retried,
      cached: verdict.cached,
    };
  }

  // Below the bar, the verdict is discarded rather than acted on.
  if (verdict.confidence < MIN_LLM_CONFIDENCE) {
    return {
      cause: 'unknown',
      confidence: verdict.confidence,
      causeBy: 'llm',
      evidence: `model:${verdict.model}`,
      reasoning: verdict.reasoning,
      exceptionReason: `low_confidence: ${verdict.confidence.toFixed(2)} < ${MIN_LLM_CONFIDENCE}`,
      parseRetried: verdict.retried,
      cached: verdict.cached,
    };
  }

  return {
    cause: verdict.cause,
    confidence: verdict.confidence,
    causeBy: 'llm',
    evidence: `model:${verdict.model}`,
    reasoning: verdict.reasoning,
    exceptionReason: null,
    parseRetried: verdict.retried,
    cached: verdict.cached,
  };
}

/**
 * Rules-only diagnosis. Synchronous, no tail, no downtime.
 * This is what the scoring harness measures — it isolates the rule table.
 */
export function diagnoseByRulesOnly(input: DiagnosisInput): {
  readonly cause: DiagnosedCause;
  readonly ruleId: string | null;
} {
  const enriched: DiagnosisInput =
    input.source === 'receivable' && input.daysOverdue === null
      ? { ...input, daysOverdue: parseDaysOverdue(input.errorReason) }
      : input;

  const match = applyRuleTable(enriched);
  return match ? { cause: match.cause, ruleId: match.ruleId } : { cause: 'unknown', ruleId: null };
}

/** The split that POLICY_SPEC requires be reported. */
export interface DiagnosisSummary {
  readonly total: number;
  readonly byRule: number;
  readonly byLlm: number;
  readonly byDowntimeSignal: number;
  readonly unknown: number;
  readonly ruleShare: number;
  readonly llmShare: number;
  readonly downtimeShare: number;
  readonly unknownRate: number;
  /** LLM calls whose first response failed Zod, over LLM calls made. */
  readonly parseFailureRate: number;
  readonly llmCalls: number;
  readonly llmParseRetries: number;
  readonly cacheHits: number;
}

export function summariseDiagnoses(diagnoses: readonly Diagnosis[]): DiagnosisSummary {
  const total = diagnoses.length;
  let byRule = 0;
  let byLlm = 0;
  let byDowntimeSignal = 0;
  let unknown = 0;
  let llmParseRetries = 0;
  let llmCalls = 0;
  let cacheHits = 0;

  for (const d of diagnoses) {
    if (d.cause === 'unknown') unknown += 1;

    switch (d.causeBy) {
      case 'downtime_signal':
        byDowntimeSignal += 1;
        break;
      case 'llm':
        byLlm += 1;
        llmCalls += 1;
        if (d.parseRetried) llmParseRetries += 1;
        if (d.cached) cacheHits += 1;
        break;
      default:
        byRule += 1;
    }
  }

  const share = (n: number): number => (total === 0 ? 0 : n / total);

  return {
    total,
    byRule,
    byLlm,
    byDowntimeSignal,
    unknown,
    ruleShare: share(byRule),
    llmShare: share(byLlm),
    downtimeShare: share(byDowntimeSignal),
    unknownRate: share(unknown),
    parseFailureRate: llmCalls === 0 ? 0 : llmParseRetries / llmCalls,
    llmCalls,
    llmParseRetries,
    cacheHits,
  };
}

export {
  ALL_CAUSES,
  CAUSES_BY_SOURCE,
  CHECKOUT_CAUSES,
  GATE_TERMINAL_CAUSES,
  MANDATE_CAUSES,
  OVERDUE_HARD_THRESHOLD_DAYS,
  PAYMENT_CAUSES,
  RECEIVABLE_CAUSES,
  TERMINAL_CAUSES,
  UNKNOWN_CAUSE,
  causesForSource,
  isCauseValidForSource,
  isRootCause,
  isTerminalCause,
  type CheckoutCause,
  type DiagnosedCause,
  type MandateCause,
  type PaymentCause,
  type ReceivableCause,
  type RootCause,
  type TerminalCause,
  type UnknownCause,
} from './taxonomy';

export {
  DIAGNOSIS_RULES,
  applyRuleTable,
  causesCoveredByRules,
  parseDaysOverdue,
  type DiagnosisInput,
  type DiagnosisRule,
  type RuleMatch,
} from './rules';

export {
  findActiveDowntime,
  windowAppliesTo,
  windowCoversInstant,
  type DowntimeQuery,
  type DowntimeWindow,
} from './downtime';

export {
  isConcreteCause,
  type DiagnosisTailPort,
  type TailFailureReason,
  type TailOutcome,
  type TailRequest,
  type TailVerdict,
} from './port';

export type { CaseSource };
