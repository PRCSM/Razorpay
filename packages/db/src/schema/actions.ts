import type { ActionStatus } from '@reflow/core';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { plans } from './plans.js';
import { recoveryCases } from './recovery-cases.js';

/**
 * `actions`
 *
 * What actually happened, externally.
 *
 * The row is written BEFORE the external call, then updated with the response.
 * If the process dies mid-call there is still a record that the call was
 * attempted — which is what lets the catch-up pass avoid double-firing.
 *
 * `lag_seconds` is the downtime-honesty metric: the gap between scheduled and
 * actual execution. An audit trail reading "executed 4h late, re-validated,
 * still compliant" is stronger than pretending downtime never happened.
 *
 * `status = 'skipped_on_regate'` records a plan dropped at execution time
 * because state had changed since planning.
 */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),

    /** null until the external call is actually made. */
    executedAt: timestamp('executed_at', { withTimezone: true, mode: 'date' }),
    /** executed_at - scheduled_for, in seconds. */
    lagSeconds: integer('lag_seconds'),

    /** The exact payload sent. */
    request: jsonb('request'),
    /** The exact response received. */
    response: jsonb('response'),

    /** Integer paise in a bigint column. */
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),

    /** success | failed | skipped_on_regate */
    status: text('status').$type<ActionStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('actions_case_id_idx').on(table.caseId),
    index('actions_plan_id_idx').on(table.planId),
    index('actions_executed_at_idx').on(table.executedAt),
  ],
);

export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
