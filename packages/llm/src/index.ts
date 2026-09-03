/**
 * @reflow/llm — the LLM boundary.
 *
 * The rule this package exists to enforce (docs/ARCHITECTURE.md):
 * "The rule engine decides. The LLM explains and handles the tail.
 *  Never the reverse."
 *
 * Everything here is worker-only. `GROQ_API_KEY` is never given to Vercel, so the
 * web app cannot make an LLM call even by accident — least privilege applied to
 * env vars (docs/ENVIRONMENT_VARIABLES.md). The one exception is the lazy
 * dashboard explanation, which the web app requests through its own route.
 */

export type {
  CompletionMeta,
  CompletionRequest,
  CompletionResult,
  InjectionVerdict,
  LlmProvider,
  ModelSlot,
} from './provider';

export {
  InMemoryLlmCache,
  NullLlmCache,
  cacheKeyFor,
  type CachedResponse,
  type LlmCacheStore,
} from './cache';

export {
  GroqClient,
  type CompletionOutcome,
  type GroqClientOptions,
  type ModelConfig,
} from './groq';

export {
  collectUntrustedText,
  heuristicInjectionScan,
  scoreFromGuardOutput,
  screenForInjection,
  type HeuristicResult,
  type InjectionScreenOptions,
  type ScreenResult,
  type UntrustedFields,
} from './guard';

export {
  GroqDiagnosisTail,
  type DiagnosisTailOptions,
} from './diagnosis-tail';

export { explainCase, type ExplainOutcome, type ExplainRequest } from './explain';
