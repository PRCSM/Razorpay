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

/** Every table this package creates, including dashboard-login `users`. */
export const TABLE_NAMES = [...DOMAIN_TABLE_NAMES, 'users'] as const;

export type DomainTableName = (typeof DOMAIN_TABLE_NAMES)[number];
export type TableName = (typeof TABLE_NAMES)[number];
