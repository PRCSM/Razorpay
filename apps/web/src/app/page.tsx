import Link from 'next/link';

/**
 * Landing page. PUBLIC, and deliberately static.
 *
 * It reads no environment variables and touches no database, so it renders on a
 * deployment that has not been given its secrets yet. That is what makes the
 * first deploy meaningful: `/` proves the build and the routing work, separately
 * from whether the platform has been configured.
 *
 * Run 1 keeps this bare. The real landing page is Run 7.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-3">
        <p className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
          Razorpay Buildathon · Track 03
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Reflow</h1>
        <p className="text-lg text-muted-foreground">
          A payment-recovery agent. It watches failed payments in real time, diagnoses why each
          one failed, picks the cheapest intervention likely to work, executes it inside hard
          guardrails, and reports measured money recovered against a baseline.
        </p>
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="rounded-lg border p-4">
          <dt className="font-medium">Four surfaces, one engine</dt>
          <dd className="mt-1 text-muted-foreground">
            Payments and mandates at full policy depth; checkout abandonment and B2B receivables
            at light depth.
          </dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="font-medium">Guardrails, not vibes</dt>
          <dd className="mt-1 text-muted-foreground">
            Eight ordered gates. Every verdict is persisted with its reason, including the plans
            that were dropped.
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-4 text-sm">
        <Link
          href="/dashboard"
          className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Dashboard
        </Link>
        <span className="text-muted-foreground">
          Foundation phase — the recovery loop lands in later runs.
        </span>
      </div>
    </main>
  );
}
