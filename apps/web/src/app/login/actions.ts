'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

/**
 * Credentials sign-in as a server action.
 *
 * Returns a message rather than throwing, so a wrong password renders as a form
 * error instead of an error boundary. `NEXT_REDIRECT` is re-thrown untouched —
 * Next.js implements redirects by throwing, and swallowing it would break the
 * navigation on a successful login.
 */
export async function authenticate(
  _previousState: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/dashboard',
    });
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case 'CredentialsSignin':
          return 'Invalid email or password.';
        default:
          return 'Could not sign in. Check the server logs.';
      }
    }
    throw error;
  }
}
