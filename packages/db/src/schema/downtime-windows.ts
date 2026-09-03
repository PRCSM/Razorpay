import type { PaymentMethod } from '@reflow/core';
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `downtime_windows`
 *
 * Issuer outages as reported by Razorpay through `payment.downtime.started`,
 * `.updated`, and `.resolved`.
 *
 * NOT one of the nine tables in docs/DATABASE_DESIGN.md — added in Run 3, see
 * ADR-029. It exists because Razorpay tells us the issuer is down directly, which
 * turns `issuer_down` from an inference about an error code into an observed fact:
 * a failure inside an active window for the same issuer and rail is diagnosed at
 * confidence 1.0 with `cause_by = 'downtime_signal'`.
 *
 * `provider_downtime_id` is UNIQUE so `.updated` and `.resolved` upsert the same
 * row rather than creating a second window for one outage. Same reasoning as
 * `raw_events.provider_event_id`: the provider retries, and a duplicate window
 * would double-count an outage.
 */
export const downtimeWindows = pgTable(
  'downtime_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Razorpay's downtime id. The upsert key. */
    providerDowntimeId: text('provider_downtime_id').notNull().unique(),

    /** Bank or PSP handle, lowercase. null = a platform-wide outage. */
    issuer: text('issuer'),
    /** Affected rail. null = all rails. */
    method: text('method').$type<PaymentMethod>(),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** null = still down. Set on `.resolved`. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),

    /** Razorpay's severity: low | medium | high. Reported, not acted on yet. */
    severity: text('severity'),
    /** Razorpay's raw status string, kept verbatim. */
    status: text('status'),
    /** Planned maintenance is still an outage, but it is distinguishable. */
    scheduled: boolean('scheduled').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The diagnosis hot path: "is there an active window for this issuer+rail?"
    index('downtime_windows_issuer_method_idx').on(table.issuer, table.method),
    index('downtime_windows_active_idx').on(table.resolvedAt, table.startedAt),
  ],
);

export type DowntimeWindowRow = typeof downtimeWindows.$inferSelect;
export type NewDowntimeWindowRow = typeof downtimeWindows.$inferInsert;
