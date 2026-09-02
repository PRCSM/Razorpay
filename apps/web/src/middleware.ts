import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

/**
 * Route protection for `/dashboard/*`.
 *
 * Built from the edge-safe half of the auth config only — no bcrypt, no database.
 *
 * The matcher is scoped deliberately. `/` is public and must stay reachable with
 * no environment configured at all, which is what lets the landing page serve on
 * a deployment that has not yet been given its secrets.
 */
const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  matcher: ['/dashboard/:path*'],
};
