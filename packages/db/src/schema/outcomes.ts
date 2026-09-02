import type { OutcomeResult } from '@reflow/core';
import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { actions } from './actions';
import { recoveryCases } from './recovery-cases';

/**
 * `outcomes`
 *
 * Did it work.
 *
 * `action_id` is nullable on purpose: some customers pay on their own. Those are
 * FALSE NUDGES if we messaged them — counted and reported, not hidden. An
 * outcome with a null action is a recovery the agent cannot claim credit for.
 */
export const outcomes = pgTable(
  'outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    /** null = recovered with no action of ours. */
    actionId: uuid('action_id').references(() => actions.id, { onDelete: 'set null' }),

    /** recovered | no_response | opted_out | failed */
    result: text('result').$type<OutcomeResult>().notNull(),
    /** Integer paise in a bigint column. */
    amountRecoveredPaise: bigint('amount_recovered_paise', { mode: 'number' })
      .notNull()
      .default(0),

    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('outcomes_case_id_idx').on(table.caseId),
    index('outcomes_action_id_idx').on(table.actionId),
    index('outcomes_result_idx').on(table.result),
  ],
);

export type OutcomeRow = typeof outcomes.$inferSelect;
export type NewOutcomeRow = typeof outcomes.$inferInsert;
