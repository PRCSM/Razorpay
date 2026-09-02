import { getWebEnv, loadPolicy } from '@reflow/core';
import { DOMAIN_TABLE_NAMES } from '@reflow/db';
import { auth, signOut } from '@/auth';

/**
 * Bare protected dashboard.
 *
 * `force-dynamic` matters: this page validates env and loads policy, so it must
 * never be prerendered at build time. A build machine legitimately has no
 * secrets, and prerendering here would either fail the deploy or push someone
 * toward adding a fallback to make it pass.
 *
 * Run 1 shows only that auth, env validation, and the policy loader work
 * end to end. The real dashboard is Run 6.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Dashboard — Reflow' };

export default async function DashboardPage() {
  const session = await auth();
  const env = getWebEnv();
  const policy = loadPolicy(env.POLICY_PATH, process.cwd());

  const gateNames = Object.keys(policy.gates);

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {session?.user?.email ?? 'unknown'}
          </p>
        </div>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/' });
          }}
        >
          <button
            type="submit"
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            Sign out
          </button>
        </form>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Foundation checks
        </h2>
        <dl className="divide-y rounded-lg border text-sm">
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Environment</dt>
            <dd className="font-medium">validated ({env.NODE_ENV})</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Policy version</dt>
            <dd className="font-medium">{policy.version}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Kill switch</dt>
            <dd className="font-medium">{policy.kill_switch ? 'ENGAGED' : 'off'}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Guardrail gates loaded</dt>
            <dd className="font-medium">{gateNames.length}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Attribution window</dt>
            <dd className="font-medium">{policy.attribution.window_hours}h</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Demo time scale</dt>
            <dd className="font-medium">{env.DEMO_TIME_SCALE}×</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-muted-foreground">Domain tables</dt>
            <dd className="font-medium">{DOMAIN_TABLE_NAMES.length}</dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          Gate chain, in evaluation order
        </h2>
        <ol className="divide-y rounded-lg border text-sm">
          {gateNames.map((name, index) => {
            const gate = policy.gates[name as keyof typeof policy.gates];
            return (
              <li key={name} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="font-mono text-xs text-muted-foreground">
                  gate {index} · {name}
                </span>
                <span className="font-medium">{gate.enabled ? 'enabled' : 'disabled'}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <p className="text-xs text-muted-foreground">
        Foundation phase. No recovery data yet — ingest, diagnosis, planning, and execution land in
        Runs 2 to 5.
      </p>
    </main>
  );
}
