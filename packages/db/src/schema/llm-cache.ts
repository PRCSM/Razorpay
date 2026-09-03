import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `llm_cache`
 *
 * Persisted LLM responses, keyed by `sha256(model + prompt)`.
 *
 * Two reasons this is a database table rather than a file on disk:
 *
 *  - **Determinism.** docs/EVAL_METHODOLOGY.md requires that re-running the eval
 *    reproduces the same numbers. Caching by input hash means a second run makes
 *    zero API calls and cannot drift.
 *  - **The worker is ephemeral.** Railway containers do not keep a filesystem
 *    between deploys, so a disk cache would be cold on every restart and would
 *    burn Groq quota re-deriving answers it already had.
 *
 * Groq's free tier binds on tokens per minute (8,000), so the cache is what makes
 * a 500-case batch feasible at all.
 *
 * NOT one of the nine tables in docs/DATABASE_DESIGN.md — added in Run 3.
 */
export const llmCache = pgTable(
  'llm_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** sha256(model + '\n' + prompt). The lookup key. */
    cacheKey: text('cache_key').notNull().unique(),

    /** Resolved model id, so a cache entry is traceable to what produced it. */
    model: text('model').notNull(),
    /** Which slot asked: diagnosis | copy | guard. */
    slot: text('slot').notNull(),

    /** The raw response text, before Zod validation. Stored as received. */
    response: text('response').notNull(),

    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),

    /** How many times this entry has been served. Proves the cache is working. */
    hitCount: integer('hit_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('llm_cache_model_slot_idx').on(table.model, table.slot)],
);

export type LlmCacheRow = typeof llmCache.$inferSelect;
export type NewLlmCacheRow = typeof llmCache.$inferInsert;
