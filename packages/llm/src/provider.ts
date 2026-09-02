/**
 * The LLM provider interface.
 *
 * Run 1 defines the contract only — no Groq client, no prompts, no cache. Those
 * land in Run 3 alongside diagnosis.
 *
 * The interface exists now for two reasons. Model ids come from env because free
 * catalogs change without notice (docs/ENVIRONMENT_VARIABLES.md), so the caller
 * must never hardcode one. And every response is Zod-validated before use —
 * docs/ARCHITECTURE.md: "Zod validation, one retry, then `unknown` — never
 * trusted raw."
 */

import type { z } from 'zod';

/** Which model slot to use. Resolved from env by the provider, never by callers. */
export type ModelSlot = 'diagnosis' | 'copy' | 'guard';

export interface CompletionRequest {
  readonly slot: ModelSlot;
  readonly system: string;
  readonly user: string;
  /** 0 for decisions that must be reproducible. */
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface CompletionMeta {
  /** The resolved model id, recorded as `plans.model_version`. */
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** True when served from the response cache rather than the API. */
  readonly cached: boolean;
  readonly latencyMs: number;
}

/**
 * A structured completion outcome.
 *
 * `invalid` is a first-class result, not an exception: an unparseable response
 * is an expected event that must be persisted with its reason
 * (docs/INSTRUCTIONS.md hard rule 6, "Nothing is silently discarded").
 */
export type CompletionResult<T> =
  | { readonly ok: true; readonly value: T; readonly meta: CompletionMeta }
  | {
      readonly ok: false;
      readonly reason: 'invalid_response' | 'rate_limited' | 'transport_error' | 'refused';
      readonly detail: string;
      readonly raw: string | null;
      readonly meta: CompletionMeta | null;
    };

/** Verdict from the prompt-injection screen (gate 0). */
export interface InjectionVerdict {
  /** True when the text looks like an injection attempt. */
  readonly detected: boolean;
  /** 0..1. Compared against `policy.gates.injection_screen.threshold`. */
  readonly score: number;
  readonly model: string;
}

export interface LlmProvider {
  /**
   * Complete and validate against `schema`. Retries once on a schema failure,
   * then returns `{ ok: false, reason: 'invalid_response' }`.
   */
  complete<T>(
    request: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>>;

  /**
   * Gate 0. Screen untrusted text BEFORE it reaches any other model.
   * Every caller passing merchant- or customer-supplied text must go through
   * this first — see docs/ARCHITECTURE.md, "Security posture".
   */
  screenForInjection(text: string): Promise<InjectionVerdict>;

  /** The resolved model id for a slot. Recorded on plans for reproducibility. */
  modelFor(slot: ModelSlot): string;
}
