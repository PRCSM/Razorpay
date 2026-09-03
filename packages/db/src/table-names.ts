/**
 * The physical table names, in one place.
 *
 * Used by the migration verifier and the seed script so "did the migration
 * actually apply?" is answered by querying the database rather than by trusting
 * that a file was written.
 */

/** The nine domain tables specified in docs/DATABASE_DESIGN.md. */
export const DOMAIN_TABLE_NAMES = [
  'merchants',
  'raw_events',
  'recovery_cases',
  'plans',
  'actions',
  'outcomes',
  'audit_log',
  'exceptions',
  'bandit_arms',
] as const;

/**
 * Tables added after the original nine.
 *
 * `users`   — dashboard login (Run 1, ADR-021)
 * `downtime_windows` — Razorpay issuer downtime (Run 3, ADR-029)
 * `llm_cache`        — persisted LLM responses (Run 3)
 */
export const SUPPORTING_TABLE_NAMES = ['users', 'downtime_windows', 'llm_cache'] as const;

/** Every table this package creates. */
export const TABLE_NAMES = [...DOMAIN_TABLE_NAMES, ...SUPPORTING_TABLE_NAMES] as const;

export type DomainTableName = (typeof DOMAIN_TABLE_NAMES)[number];
export type SupportingTableName = (typeof SUPPORTING_TABLE_NAMES)[number];
export type TableName = (typeof TABLE_NAMES)[number];
