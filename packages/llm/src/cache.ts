/**
 * The LLM response cache, keyed by `sha256(model + prompt)`.
 *
 * Two jobs, both load-bearing:
 *
 *  - **Determinism.** docs/EVAL_METHODOLOGY.md: "LLM responses are cached by input
 *    hash, so re-runs are deterministic and don't re-consume Groq quota." Without
 *    this, two eval runs over the same 500 cases could disagree, and every number
 *    in RESULTS.md would be a snapshot rather than a measurement.
 *  - **Staying inside the free tier.** Groq allows 8,000 tokens per minute. A
 *    500-case batch does not fit if every case is a fresh call.
 *
 * The key includes the model, so changing `LLM_MODEL_DIAGNOSIS` correctly misses
 * the cache instead of silently serving an answer from a different model.
 *
 * The store is an interface: the worker backs it with the `llm_cache` table, and
 * tests use the in-memory implementation.
 */

import { createHash } from 'node:crypto';

export interface CachedResponse {
  readonly response: string;
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly latencyMs: number | null;
}

/** Persistence for the cache. Implemented over Postgres in the worker. */
export interface LlmCacheStore {
  get(cacheKey: string): Promise<CachedResponse | null>;
  set(cacheKey: string, entry: CachedResponse & { slot: string }): Promise<void>;
}

/**
 * The cache key.
 *
 * Model first so entries group by model, and a newline separator so
 * `("ab", "c")` and `("a", "bc")` cannot collide.
 */
export function cacheKeyFor(model: string, prompt: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`, 'utf8').digest('hex');
}

/** In-memory store. For tests and for a run that deliberately wants no persistence. */
export class InMemoryLlmCache implements LlmCacheStore {
  private readonly entries = new Map<string, CachedResponse & { slot: string }>();

  /** Call counters, so a test can prove a cache hit avoided a second call. */
  public reads = 0;
  public writes = 0;

  async get(cacheKey: string): Promise<CachedResponse | null> {
    this.reads += 1;
    return this.entries.get(cacheKey) ?? null;
  }

  async set(cacheKey: string, entry: CachedResponse & { slot: string }): Promise<void> {
    this.writes += 1;
    this.entries.set(cacheKey, entry);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** A cache that never hits. For forcing live calls. */
export class NullLlmCache implements LlmCacheStore {
  async get(): Promise<CachedResponse | null> {
    return null;
  }
  async set(): Promise<void> {
    // intentionally empty
  }
}
