/**
 * @reflow/llm — the LLM boundary.
 *
 * Run 1: the provider interface only. Run 3 adds the Groq implementation,
 * prompts, the injection screen, and the input-hash response cache.
 *
 * The rule this package exists to enforce (docs/ARCHITECTURE.md):
 * "The rule engine decides. The LLM explains and handles the tail.
 *  Never the reverse."
 */

export type {
  CompletionMeta,
  CompletionRequest,
  CompletionResult,
  InjectionVerdict,
  LlmProvider,
  ModelSlot,
} from './provider.js';
