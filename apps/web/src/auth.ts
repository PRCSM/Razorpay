import { getWebEnv } from '@reflow/core';
import { createServerlessDb, users } from '@reflow/db';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { authConfig } from './auth.config';

/**
 * Full Auth.js setup: the edge-safe base plus the credentials provider.
 *
 * There is NO signup flow. One user is seeded by `pnpm db:seed`; the dashboard
 * is a demo surface, not a product with accounts.
 *
 * The configuration is a FUNCTION rather than an object so `getWebEnv()` runs
 * per request instead of at module import. Next.js evaluates modules while
 * building, and validating there would make a production build require live
 * secrets — the pressure that leads to exactly the `?? 'default'` fallback
 * docs/ENVIRONMENT_VARIABLES.md forbids. The validation itself is unchanged: a
 * missing AUTH_SECRET still throws by name, on the first request.
 */

const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getWebEnv();

  return {
    ...authConfig,
    secret: env.AUTH_SECRET,
    trustHost: true,
    providers: [
      Credentials({
        name: 'credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        async authorize(raw) {
          const parsed = credentialsSchema.safeParse(raw);
          if (!parsed.success) return null;

          const email = parsed.data.email.trim().toLowerCase();
          const db = createServerlessDb(env.DATABASE_URL);

          const found = await db
            .select({
              id: users.id,
              email: users.email,
              name: users.name,
              merchantId: users.merchantId,
              passwordHash: users.passwordHash,
            })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

          const user = found[0];

          // Compare against a dummy hash when the user does not exist, so a
          // missing account and a wrong password take the same time. Cheap
          // defence against user enumeration by timing.
          const hash =
            user?.passwordHash ??
            '$2a$12$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
          const passwordMatches = await bcrypt.compare(parsed.data.password, hash);

          if (!user || !passwordMatches) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            merchantId: user.merchantId,
          };
        },
      }),
    ],
  };
});
