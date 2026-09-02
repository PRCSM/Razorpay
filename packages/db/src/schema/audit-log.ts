import type { AuditActor } from '@reflow/core';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { recoveryCases } from './recovery-cases';

/**
 * `audit_log`
 *
 * Append-only, hash-chained. No updates, no deletes — enforced by convention in
 * the repository layer (a DB trigger would be nicer and is not worth the time,
 * per docs/DATABASE_DESIGN.md).
 *
 * `hash = sha256(prev_hash || canonicalJson(payload))`. Canonical JSON means
 * SORTED KEYS: without that, the same payload hashes differently across runs and
 * the chain is worthless.
 *
 * Ships with `verifyChain()` for tamper-evidence and full replay of any case.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: some events are system-wide rather than case-scoped. */
    caseId: uuid('case_id').references(() => recoveryCases.id, { onDelete: 'set null' }),

    /** 'system' | 'llm' | 'human' | 'scheduler' */
    actor: text('actor').$type<AuditActor>().notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),

    /** null only for the very first entry in the chain. */
    prevHash: text('prev_hash'),
    /** sha256(prev_hash || canonicalJson(payload)) */
    hash: text('hash').notNull(),

    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_case_id_idx').on(table.caseId),
    // Chain verification walks entries in insertion order.
    index('audit_log_at_idx').on(table.at),
    index('audit_log_hash_idx').on(table.hash),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
