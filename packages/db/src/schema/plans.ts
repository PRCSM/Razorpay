import type { ActionType, Channel, GateResult, PlanStatus } from '@reflow/core';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { recoveryCases } from './recovery-cases.js';

/**
 * `plans`
 *
 * The agent's intent, before it acts. A plan is a DECISION RECORD, not a queue
 * entry — pg-boss owns scheduling; this table owns the reasoning.
 *
 * Plans are kept even when dropped. A dropped plan carrying its gate reasons is
 * the evidence that the guardrails work, which makes it the most interesting
 * data in the system. Deleting them would erase exactly that.
 *
 * `policy_version` + `model_version` on every row make any decision reproducible
 * months later.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),

    /**
     * immediate_retry | delayed_retry | method_switch | payment_link | nudge |
     * pre_debit_notice | promise_to_pay | escalate_human | stop
     */
    actionType: text('action_type').$type<ActionType>().notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),

    /** 'sms' | 'whatsapp' | 'email' | 'none' */
    channel: text('channel').$type<Channel>(),
    /** DLT template id. Required when the channel is sms (gate 7). */
    templateId: text('template_id'),

    /** Expected recovery probability, 0..1. */
    expectedP: real('expected_p').notNull(),
    /** Integer paise in a bigint column. */
    estCostPaise: bigint('est_cost_paise', { mode: 'number' }).notNull().default(0),

    /** From policy.yaml `version`. */
    policyVersion: text('policy_version').notNull(),
    /** The LLM model used, if any. */
    modelVersion: text('model_version'),

    /** [{ gate, passed, reason }] — every gate verdict, nothing discarded. */
    guardrailResults: jsonb('guardrail_results')
      .$type<GateResult[]>()
      .notNull()
      .default([]),

    /** pending | executed | dropped | downgraded */
    status: text('status').$type<PlanStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The scheduler's hot path, per docs/DATABASE_DESIGN.md.
    index('plans_scheduled_for_status_idx').on(table.scheduledFor, table.status),
    index('plans_case_id_idx').on(table.caseId),
  ],
);

export type PlanRow = typeof plans.$inferSelect;
export type NewPlanRow = typeof plans.$inferInsert;
