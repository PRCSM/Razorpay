import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { merchants } from './merchants';

/**
 * `users` — dashboard login only.
 *
 * NOT one of the nine tables in docs/DATABASE_DESIGN.md. That document describes
 * the recovery domain; this table exists solely because TASK 5 requires an
 * Auth.js credentials provider with one seeded user, and a credentials provider
 * needs somewhere to check a password hash.
 *
 * Deliberately minimal: no signup flow, no sessions table (Auth.js uses a JWT
 * strategy), no password reset. Logged as a deviation in docs/DECISIONS.md.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    email: text('email').notNull().unique(),
    name: text('name'),
    /** bcrypt hash. A plaintext password is never stored or logged. */
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('users_merchant_id_idx').on(table.merchantId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
