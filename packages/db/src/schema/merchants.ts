import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `merchants`
 *
 * Multi-tenancy is MODELLED but NOT ENFORCED. `merchant_id` sits on every table
 * so the shape is right, but RLS is off — see docs/ARCHITECTURE.md, "Deliberately
 * not built". Retrofitting a tenant column later is painful; adding RLS later is
 * easy. One seeded merchant for the demo.
 */
export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
