/**
 * Gate 0 — the prompt-injection screen.
 *
 * ALL untrusted text passes through here before any other model sees it:
 * `customer_ref`, `error_reason`, invoice notes, VPA handles, merchant
 * descriptions — anything a merchant or customer supplied.
 *
 * docs/ARCHITECTURE.md: "Prompt injection is a real threat here, not a
 * theoretical one. The system ingests merchant- and customer-supplied text and
 * feeds it to a model that influences money decisions."
 *
 * Above `policy.yaml gates.injection_screen.threshold` the case is flagged, the
 * LLM is SKIPPED ENTIRELY, and the case routes to exceptions with reason
 * `injection_suspected`. Not sanitised, not truncated — skipped. Sanitising an
 * injection attempt still hands the attacker's text to the model.
 */

import type { GroqClient } from './groq';
import type { InjectionVerdict } from './provider';

/** The fields screened for a diagnosis call, in a stable order. */
export interface UntrustedFields {
  readonly customerRef?: string | null;
  readonly errorReason?: string | null;
  readonly errorCode?: string | null;
  readonly errorSource?: string | null;
  readonly errorStep?: string | null;
  readonly issuer?: string | null;
  readonly notes?: string | null;
}

/**
 * Collect the untrusted values into one block for screening.
 *
 * Screening the concatenation rather than each field separately is deliberate: an
 * injection can be split across fields so that no single one looks malicious while
 * the assembled prompt does.
 */
export function collectUntrustedText(fields: UntrustedFields): string {
  const ordered: readonly (string | null | undefined)[] = [
    fields.customerRef,
    fields.errorCode,
    fields.errorSource,
    fields.errorStep,
    fields.errorReason,
    fields.issuer,
    fields.notes,
  ];
  return ordered
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join('\n');
}

/**
 * Heuristic pre-screen.
 *
 * Runs BEFORE the model, for two reasons: it costs no quota, and it still works
 * when Groq is unreachable — a screen that fails open the moment the API is down
 * is not a security control. The model catches what these patterns miss; these
 * catch the blunt attempts for free.
 */
const INJECTION_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?/i, label: 'ignore-previous-instructions' },
  { pattern: /disregard\s+(all\s+|the\s+)?(previous|prior|above|system)/i, label: 'disregard-previous' },
  { pattern: /you\s+are\s+now\s+(a|an|the)\b/i, label: 'role-reassignment' },
  { pattern: /\b(system|developer)\s*(prompt|message)\s*:/i, label: 'fake-system-turn' },
  { pattern: /<\/?(system|assistant|user)>/i, label: 'chat-markup-injection' },
  { pattern: /\bnew\s+instructions?\s*:/i, label: 'new-instructions' },
  { pattern: /reveal|print|repeat\s+(your\s+)?(system\s+)?(prompt|instructions)/i, label: 'prompt-exfiltration' },
  { pattern: /\boverride\s+(the\s+)?(policy|guardrail|gate|threshold)/i, label: 'guardrail-override' },
  { pattern: /\bmark\s+(this|the)\s+case\s+as\b/i, label: 'outcome-steering' },
  { pattern: /\b(refund|approve|capture)\s+(this|the)\s+(payment|amount|case)\b/i, label: 'money-action-steering' },
];

export interface HeuristicResult {
  readonly detected: boolean;
  readonly labels: readonly string[];
}

export function heuristicInjectionScan(text: string): HeuristicResult {
  const labels: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) labels.push(label);
  }
  return { detected: labels.length > 0, labels };
}

export interface InjectionScreenOptions {
  readonly enabled: boolean;
  /** From policy.yaml `gates.injection_screen.threshold`. */
  readonly threshold: number;
  /** Skip the model call and rely on heuristics only. */
  readonly heuristicOnly?: boolean;
}

export interface ScreenResult extends InjectionVerdict {
  /** 'heuristic' | 'model' | 'disabled' | 'unavailable' */
  readonly by: string;
  readonly labels: readonly string[];
  /** True when the model could not be reached and the heuristic decided alone. */
  readonly degraded: boolean;
}

/**
 * Map Prompt Guard's answer onto a 0..1 score.
 *
 * `meta-llama/llama-prompt-guard-2-86m` returns a BARE PROBABILITY as the message
 * content — e.g. `"0.9995654225349426"` for an attack and `"0.0005332987"` for
 * benign text. Verified against the live API, not assumed.
 *
 * The label branches below are a fallback for a differently-behaved guard model,
 * since `LLM_MODEL_GUARD` is configurable and free catalogs change without notice.
 */
export function scoreFromGuardOutput(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === '') return null;

  // The expected shape: the whole response is a probability.
  // The regex matters — `Number('')` and `Number('  ')` are both 0, which would
  // otherwise read as "definitely benign" and fail the screen open.
  if (/^\d*\.?\d+(e[+-]?\d+)?$/.test(text)) {
    const asNumber = Number(text);
    if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber <= 1) return asNumber;
  }

  if (/\b(jailbreak|injection|malicious|attack|unsafe)\b/.test(text)) return 0.95;
  if (/\b(benign|safe|clean)\b/.test(text)) return 0.02;

  // A probability embedded in prose.
  const embedded = /(^|[^0-9.])(0?\.\d+|1(\.0+)?|0)($|[^0-9.])/.exec(text);
  if (embedded?.[2]) {
    const value = Number(embedded[2]);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return null;
}

/**
 * Screen untrusted text. Heuristics first, then the model.
 *
 * Fails CLOSED on a heuristic hit: if the cheap check is confident, no model call
 * is made and the text is refused. It fails OPEN only when the model is
 * unreachable AND the heuristics found nothing, and that case is marked
 * `degraded: true` so the decision is visible rather than silent.
 */
export async function screenForInjection(
  text: string,
  client: GroqClient,
  options: InjectionScreenOptions,
): Promise<ScreenResult> {
  const model = client.modelFor('guard');

  if (!options.enabled) {
    return { detected: false, score: 0, model, by: 'disabled', labels: [], degraded: false };
  }
  if (text.trim() === '') {
    return { detected: false, score: 0, model, by: 'empty', labels: [], degraded: false };
  }

  const heuristic = heuristicInjectionScan(text);
  if (heuristic.detected) {
    // Confident and free. No reason to spend a call confirming it.
    return {
      detected: true,
      score: 1,
      model,
      by: 'heuristic',
      labels: heuristic.labels,
      degraded: false,
    };
  }

  if (options.heuristicOnly === true) {
    return { detected: false, score: 0, model, by: 'heuristic', labels: [], degraded: false };
  }

  /**
   * Prompt Guard is a TEXT CLASSIFIER, not a chat model. It takes exactly one
   * user message containing the text to classify — Groq rejects a system message
   * with "messages must contains a single user message for text classification
   * models" — and it must not be wrapped in a fence or an instruction, because
   * anything added becomes part of what gets classified.
   */
  const outcome = await client.complete({
    slot: 'guard',
    user: text,
    temperature: 0,
    maxTokens: 16,
  });

  if (!outcome.ok || outcome.text === null) {
    return {
      detected: false,
      score: 0,
      model,
      by: 'unavailable',
      labels: [],
      degraded: true,
    };
  }

  const score = scoreFromGuardOutput(outcome.text);
  if (score === null) {
    // An unparseable verdict is not a clean bill of health.
    return {
      detected: false,
      score: 0,
      model,
      by: 'unparseable',
      labels: [],
      degraded: true,
    };
  }

  return {
    detected: score >= options.threshold,
    score,
    model,
    by: 'model',
    labels: [],
    degraded: false,
  };
}
