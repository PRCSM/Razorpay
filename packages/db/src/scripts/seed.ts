/**
 * Seed the demo merchant and the single dashboard user.
 *
 * Idempotent — safe to re-run. No recovery cases are seeded here; synthetic case
 * generation is Run 2's job (`pnpm eval:seed`).
 *
 * Run with `pnpm db:seed`.
 */

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createPooledDb } from '../client';
import { merchants, users } from '../schema/index';
import { bootstrapDbEnv, describeConnection } from './env';

/** docs/DATABASE_DESIGN.md: "One seeded merchant for the demo." */
export const DEMO_MERCHANT_NAME = 'Demo Merchant';
export const DEMO_USER_EMAIL = 'demo@reflow.dev';
export const DEMO_USER_NAME = 'Demo Operator';

/**
 * Dashboard password.
 *
 * The default is a known, documented demo credential — the dashboard shows
 * synthetic data only and holds no PII, and judges need to be able to sign in.
 * Because this repository is PUBLIC, set `SEED_USER_PASSWORD` before seeding if
 * you want a credential that is not visible in the source.
 */
const DEFAULT_DEMO_PASSWORD = 'reflow-demo-2026';

const BCRYPT_ROUNDS = 12;

async function main(): Promise<void> {
  const { databaseUrl } = bootstrapDbEnv();
  const password = process.env['SEED_USER_PASSWORD']?.trim() || DEFAULT_DEMO_PASSWORD;
  const usingDefault = password === DEFAULT_DEMO_PASSWORD;

  console.log('[seed] target:', describeConnection(databaseUrl));

  const { db, pool } = createPooledDb(databaseUrl, { max: 1 });
  try {
    // ---- merchant ---------------------------------------------------------
    const existingMerchant = await db
      .select({ id: merchants.id, name: merchants.name })
      .from(merchants)
      .where(eq(merchants.name, DEMO_MERCHANT_NAME))
      .limit(1);

    let merchantId: string;
    const found = existingMerchant[0];
    if (found) {
      merchantId = found.id;
      console.log(`[seed] merchant already present: ${found.name} (${merchantId})`);
    } else {
      const inserted = await db
        .insert(merchants)
        .values({ name: DEMO_MERCHANT_NAME })
        .returning({ id: merchants.id });
      const row = inserted[0];
      if (!row) throw new Error('merchant insert returned no row');
      merchantId = row.id;
      console.log(`[seed] merchant created: ${DEMO_MERCHANT_NAME} (${merchantId})`);
    }

    // ---- dashboard user ---------------------------------------------------
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const existingUser = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, DEMO_USER_EMAIL))
      .limit(1);

    if (existingUser[0]) {
      // Re-hash on every seed so rotating SEED_USER_PASSWORD actually takes effect.
      await db
        .update(users)
        .set({ passwordHash, merchantId, name: DEMO_USER_NAME })
        .where(eq(users.email, DEMO_USER_EMAIL));
      console.log(`[seed] user updated: ${DEMO_USER_EMAIL}`);
    } else {
      await db.insert(users).values({
        email: DEMO_USER_EMAIL,
        name: DEMO_USER_NAME,
        merchantId,
        passwordHash,
      });
      console.log(`[seed] user created: ${DEMO_USER_EMAIL}`);
    }

    console.log('\n[seed] done. Dashboard login:');
    console.log(`  email    : ${DEMO_USER_EMAIL}`);
    console.log(
      usingDefault
        ? `  password : ${DEFAULT_DEMO_PASSWORD}   (default — public in this repo)`
        : '  password : (from SEED_USER_PASSWORD — not printed)',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
