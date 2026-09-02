import { pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * `bandit_arms`
 *
 * Thompson sampling state for retry timing.
 *
 * Beta-Bernoulli conjugate: `alpha` counts successes, `beta` failures, both
 * starting at 1 for a uniform prior. Sample from Beta(alpha, beta) per arm and
 * pick the highest.
 *
 * An empty table means the static timing table is used. The system degrades to
 * sensible defaults rather than to nothing.
 */
export const banditArms = pgTable(
  'bandit_arms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. 'hdfc:card:insufficient_funds' — issuer × method × cause. */
    bucketKey: text('bucket_key').notNull(),
    /** e.g. '2h' | '6h' | '18h' | '48h', from policy.yaml timing.bandit_arms_hours. */
    arm: text('arm').notNull(),

    /** Successes + 1. Uniform prior. */
    alpha: real('alpha').notNull().default(1),
    /** Failures + 1. Uniform prior. */
    beta: real('beta').notNull().default(1),

    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // UNIQUE (bucket_key, arm) — one posterior per arm per bucket. Also the
    // upsert target when an outcome updates the arm.
    unique('bandit_arms_bucket_arm_unique').on(table.bucketKey, table.arm),
  ],
);

export type BanditArmRow = typeof banditArms.$inferSelect;
export type NewBanditArmRow = typeof banditArms.$inferInsert;
