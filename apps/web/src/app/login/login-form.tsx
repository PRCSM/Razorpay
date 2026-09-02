'use client';

import { useActionState } from 'react';
import { authenticate } from './actions';

/**
 * Sign-in form. One seeded user, no signup, no password reset.
 * The credential is created by `pnpm db:seed`.
 */
export function LoginForm() {
  const [errorMessage, formAction, isPending] = useActionState<string | undefined, FormData>(
    authenticate,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          defaultValue="demo@reflow.dev"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? 'Signing in…' : 'Sign in'}
      </button>

      {/* aria-live so the error is announced, not just shown. */}
      <p aria-live="polite" role="status" className="min-h-5 text-sm text-destructive">
        {errorMessage}
      </p>
    </form>
  );
}
