import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `raw_events`
 *
 * Every webhook exactly as received. Never mutated.
 *
 * The UNIQUE on `provider_event_id` is the single most load-bearing constraint
 * in the database. Razorpay retries webhook delivery; without it, one retried
 * `payment.failed` becomes two recovery cases and the customer gets contacted
 * twice. docs/DATABASE_DESIGN.md calls this "the difference between a correct
 * system and an embarrassing one".
 *
 * `processed_at` doubles as the worker's ingestion queue pointer — null means
 * the worker has not consumed the row yet, so no separate queue table is needed.
 */
export const rawEvents = pgTable(
  'raw_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Idempotency key. Razorpay's event id. */
    providerEventId: text('provider_event_id').notNull().unique(),
    eventType: text('event_type').notNull(),
    /** The provider payload, raw. Never discard what the provider sent. */
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** null = the worker has not consumed this event yet. */
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    // The worker's ingestion scan: unprocessed events, oldest first.
    index('raw_events_processed_at_idx').on(table.processedAt, table.receivedAt),
    index('raw_events_event_type_idx').on(table.eventType),
  ],
);

export type RawEvent = typeof rawEvents.$inferSelect;
export type NewRawEvent = typeof rawEvents.$inferInsert;
