import Link from 'next/link';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — Reflow' };

/**
 * Public sign-in page. Rendered dynamically because the server action it posts
 * to needs a live request; nothing here is prerenderable.
 */
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          One seeded operator account. There is no signup.
        </p>
      </div>

      <LoginForm />

      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Back to the landing page
      </Link>
    </main>
  );
}
