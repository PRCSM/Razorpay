/**
 * The LLM tail, as a PORT.
 *
 * `packages/core` must stay pure, but the tail needs a network call. The
 * resolution is dependency inversion: core defines this interface and receives an
 * implementation as an argument. `packages/llm` supplies the Groq-backed one; the
 * eval harness can supply a recorded or stubbed one.
 *
 * Core therefore never imports `@reflow/llm` — the purity fence in
 * `eslint.config.mjs` blocks exactly that import, on purpose.
 */

import type { DiagnosedCause, RootCause } from './taxonomy';

/** The text handed to the LLM. Already screened by gate 0 before it gets here. */
export interface TailRequest {
  readonly source: 'payment' | 'mandate' | 'checkout' | 'receivable';
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly errorReason: string | null;
  readonly method: string | null;
  readonly issuer: string | null;
  /** Only these causes are legal for this source. The prompt must enumerate them. */
  readonly allowedCauses: readonly string[];
}

/**
 * What the LLM must return, after Zod validation.
 * `cause` is constrained to the taxonomy; `unknown` signals an admitted failure.
 */
export interface TailVerdict {
  readonly cause: DiagnosedCause;
  /** 0..1. Below the threshold the verdict is discarded as `unknown`. */
  readonly confidence: number;
  readonly reasoning: string;
  /** Resolved model id, recorded so a decision is reproducible later. */
  readonly model: string;
  /** True when served from the response cache — no quota was consumed. */
  readonly cached: boolean;
  /** True when the first response failed Zod and the single retry was used. */
  readonly retried: boolean;
}

/**
 * Why a tail attempt produced no usable verdict. All persisted with the case —
 * nothing is silently discarded (INSTRUCTIONS.md hard rule 6).
 */
export type TailFailureReason =
  | 'injection_suspected'
  | 'invalid_response'
  | 'low_confidence'
  | 'rate_limited'
  | 'transport_error'
  | 'not_configured';

export type TailOutcome =
  | { readonly ok: true; readonly verdict: TailVerdict }
  | {
      readonly ok: false;
      readonly reason: TailFailureReason;
      readonly detail: string;
      /** True when the first response failed validation before giving up. */
      readonly retried: boolean;
    };

/**
 * The port core calls for unmapped tuples.
 *
 * Implementations MUST screen untrusted text through gate 0 before any other
 * model sees it, and MUST reject a cause outside `allowedCauses`.
 */
export interface DiagnosisTailPort {
  diagnose(request: TailRequest): Promise<TailOutcome>;
}

/** Guard for narrowing a validated cause. */
export function isConcreteCause(cause: DiagnosedCause): cause is RootCause {
  return cause !== 'unknown';
}
