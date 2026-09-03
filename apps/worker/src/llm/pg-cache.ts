/**
 * The `llm_cache` table behind the `LlmCacheStore` interface.
 *
 * This is the impure half of the cache: `packages/llm` defines the contract and
 * knows nothing about Postgres, and the worker supplies persistence. Same
 * inversion as the diagnosis port.
 *
 * `hit_count` and `last_used_at` are updated on every read, which is what makes
 * "the re-run made zero new LLM calls" a claim backed by data rather than by a
 * log line.
 */

import type { CachedResponse, LlmCacheStore } from '@reflow/llm';
import { llmCache, type PooledDb } from '@reflow/db';
import { eq, sql } from 'drizzle-orm';

export class PostgresLlmCache implements LlmCacheStore {
  public hits = 0;
  public misses = 0;
  public writes = 0;

  constructor(private readonly db: PooledDb) {}

  async get(cacheKey: string): Promise<CachedResponse | null> {
    const rows = await this.db
      .select({
        response: llmCache.response,
        model: llmCache.model,
        promptTokens: llmCache.promptTokens,
        completionTokens: llmCache.completionTokens,
        latencyMs: llmCache.latencyMs,
      })
      .from(llmCache)
      .where(eq(llmCache.cacheKey, cacheKey))
      .limit(1);

    const row = rows[0];
    if (!row) {
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    // Fire-and-forget would risk losing the update on shutdown, so it is awaited;
    // it is a single indexed UPDATE and costs almost nothing.
    await this.db
      .update(llmCache)
      .set({ hitCount: sql`${llmCache.hitCount} + 1`, lastUsedAt: new Date() })
      .where(eq(llmCache.cacheKey, cacheKey));

    return {
      response: row.response,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      latencyMs: row.latencyMs,
    };
  }

  async set(cacheKey: string, entry: CachedResponse & { slot: string }): Promise<void> {
    this.writes += 1;
    // Two workers could race on the same prompt; the first write wins and the
    // second is a no-op rather than a constraint violation.
    await this.db
      .insert(llmCache)
      .values({
        cacheKey,
        model: entry.model,
        slot: entry.slot,
        response: entry.response,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        latencyMs: entry.latencyMs,
        hitCount: 0,
      })
      .onConflictDoNothing({ target: llmCache.cacheKey });
  }
}
