import type { CaseSource, CaseStatus, CauseSource, PaymentMethod } from '@reflow/core';
import type { GroundTruth } from '@reflow/core';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { merchants } from './merchants.js';

/**
 * `recovery_cases`
 *
 * The central entity: one row per unit of revenue at risk, regardless of source.
 * Four surfaces — payment, mandate, checkout, receivable — collapse into this one
 * shape, so everything downstream is source-agnostic.
 *
 * `is_synthetic` and `ground_truth` are the honesty columns. They let one
 * database hold both data lanes without ever blending them: every eval query
 * filters `is_synthetic = true`, and the dashboard shows both but labels them.
 *
 * `cause_by` makes the LLM's role auditable. If most cases resolve via `'llm'`,
 * the rule table is too thin and the metrics are less defensible. Reported in
 * RESULTS.md.
 */
export const recoveryCases = pgTable(
  'recovery_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    /** 'payment' | 'mandate' | 'checkout' | 'receivable' */
    source: text('source').$type<CaseSource>().notNull(),
    /** Razorpay payment / subscription / invoice id. */
    externalRef: text('external_ref'),

    /**
     * Money is integer paise in a `bigint` column. Never a float, never rupees.
     * `mode: 'number'` maps onto the `Paise` domain type in @reflow/core, whose
     * ceiling is Number.MAX_SAFE_INTEGER — around ₹90 trillion, far above any
     * real payment. The storage type stays `bigint` as the spec requires.
     */
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('INR'),

    /** Opaque. Never a real name, email, or phone — the system holds no PII. */
    customerRef: text('customer_ref'),

    /** 'card' | 'upi' | 'netbanking' | 'wallet' | 'emandate' */
    method: text('method').$type<PaymentMethod>(),
    /** Bank or PSP handle. */
    issuer: text('issuer'),

    errorCode: text('error_code'),
    errorSource: text('error_source'),
    errorStep: text('error_step'),
    errorReason: text('error_reason'),

    rootCause: text('root_cause'),
    causeConfidence: real('cause_confidence'),
    /** 'rule' | 'llm' — which path decided the cause. */
    causeBy: text('cause_by').$type<CauseSource>(),

    /** open | diagnosed | planned | acting | recovered | stopped | exception */
    status: text('status').$type<CaseStatus>().notNull().default('open'),
    attemptCount: integer('attempt_count').notNull().default(0),

    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),

    /** Honesty column: separates the synthetic lane from the live one. */
    isSynthetic: boolean('is_synthetic').notNull().default(false),
    /** Synthetic cases only. The live system never reads this. */
    groundTruth: jsonb('ground_truth').$type<GroundTruth>(),
  },
  (table) => [
    // Exactly the four indexes listed in docs/DATABASE_DESIGN.md.
    index('recovery_cases_merchant_status_idx').on(table.merchantId, table.status),
    index('recovery_cases_root_cause_idx').on(table.rootCause),
    index('recovery_cases_is_synthetic_idx').on(table.isSynthetic),
    index('recovery_cases_source_status_idx').on(table.source, table.status),
  ],
);

export type RecoveryCaseRow = typeof recoveryCases.$inferSelect;
export type NewRecoveryCaseRow = typeof recoveryCases.$inferInsert;
