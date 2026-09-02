import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe Auth.js configuration.
 *
 * Deliberately free of bcrypt, `pg`, and Drizzle. Middleware runs in the Edge
 * runtime, so anything it imports must be edge-compatible — bundling the
 * credentials `authorize` callback (which needs bcrypt and a database) into
 * middleware would break the build.
 *
 * The full configuration lives in `./auth.ts`, which spreads this file and adds
 * the provider. Middleware imports only this half.
 */
export const authConfig = {
  /**
   * Empty here on purpose. The credentials provider needs bcrypt and a database
   * connection, neither of which can run in the Edge runtime, so `./auth.ts`
   * spreads this object and supplies the real provider list.
   */
  providers: [],

  /** JWT sessions: no sessions table, and middleware can verify without a DB round trip. */
  session: { strategy: 'jwt' },

  pages: {
    signIn: '/login',
  },

  callbacks: {
    /**
     * Route protection. `/` and `/login` stay public; everything under
     * `/dashboard` requires a session.
     */
    authorized({ auth, request }) {
      const isSignedIn = auth?.user != null;
      const isDashboard = request.nextUrl.pathname.startsWith('/dashboard');

      if (isDashboard) return isSignedIn;

      // Signed-in users landing on /login go straight to the dashboard.
      if (isSignedIn && request.nextUrl.pathname === '/login') {
        return Response.redirect(new URL('/dashboard', request.nextUrl));
      }

      return true;
    },

    jwt({ token, user }) {
      if (user) {
        token['merchantId'] = (user as { merchantId?: string }).merchantId;
      }
      return token;
    },

    session({ session, token }) {
      if (session.user) {
        const merchantId = token['merchantId'];
        if (typeof merchantId === 'string') {
          (session.user as { merchantId?: string }).merchantId = merchantId;
        }
        if (typeof token.sub === 'string') {
          session.user.id = token.sub;
        }
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
