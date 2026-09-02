import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { recoveryCases } from './recovery-cases.js';

/**
 * `exceptions`
 *
 * Everything the agent refused to handle.
 *
 * The track brief asks for an honest exception list; this table is that list, and
 * it gets its own dashboard view. A system that admits what it could not resolve
 * is more credible than one claiming complete coverage.
 */
export const exceptions = pgTable(
  'exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    needsHuman: boolean('needs_human').notNull().default(true),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('exceptions_case_id_idx').on(table.caseId),
    // The dashboard's default view: open items needing a human.
    index('exceptions_needs_human_resolved_idx').on(table.needsHuman, table.resolvedAt),
  ],
);

export type ExceptionRow = typeof exceptions.$inferSelect;
export type NewExceptionRow = typeof exceptions.$inferInsert;
