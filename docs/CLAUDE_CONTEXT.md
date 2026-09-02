# CLAUDE_CONTEXT

**The living state of this project.** Rewritten at the end of every run.
This is how a session with no memory picks up where the last one stopped.

Operating mode is **AUTONOMOUS** — see `docs/INSTRUCTIONS.md`. The human is not
reviewing between phases, so this file is also their only status window. Keep it
honest and keep it current.

---

## Current phase

`RUN 1 — Foundation · ⚠️ done with one known gap (Vercel deploy fails)`

Next: **RUN 2 — Ingest** (`CLAUDE_CODE_PROMPTS.md`)

---

## Completed

**Run 1 — Foundation.** Git initialised and secured, pnpm monorepo scaffolded,
the nine-table schema migrated to Neon, env and policy validation implemented and
tested, auth working with a seeded user, local Postgres and CI configured.

Eight of nine completion criteria verified by running them. The ninth — a green
Vercel deployment — fails, and the cause is outside what this session can reach.
Details under **Known issues**.

---

## Phase status

| # | Run | Status |
|---|---|---|
| 1 | Foundation — gitignore, monorepo, schema, auth | ⚠️ Done, Vercel deploy failing |
| 2 | Ingest — webhooks, normalization, synthetic generator | ⬜ Not started |
| 3 | Diagnosis — rule engine, LLM tail, injection gate | ⬜ Not started |
| 4 | Policy + guardrails | ⬜ Not started |
| 5 | Scheduler + execution + outcomes | ⬜ Not started |
| 6 | Dashboard | ⬜ Not started |
| 7 | Eval harness + landing page | ⬜ Not started |
| 8 | Deploy + audit + test prep | ⬜ Not started |

⬜ not started · 🟡 in progress · ✅ done · ⚠️ done with known gaps · 🛑 halted

---

## Files changed this run

**Git and tooling**
`.gitignore` (rewritten) · `.gitattributes` · `.npmrc` · `pnpm-workspace.yaml` ·
`package.json` · `tsconfig.base.json` · `eslint.config.mjs` · `.prettierrc.json` ·
`.prettierignore` · `vitest.config.mts` · `docker-compose.yml` ·
`.github/workflows/ci.yml`

**packages/core** — pure domain
`src/index.ts` · `src/money.ts` · `src/money.test.ts` · `src/types/enums.ts` ·
`src/types/domain.ts` · `src/env/{schema,load,index}.ts` · `src/env/schema.test.ts` ·
`src/policy/{schema,load,index}.ts` · `src/policy/{schema,load}.test.ts` ·
`package.json` · `tsconfig.json`

**packages/db** — the only place SQL lives
`src/schema/{merchants,raw-events,recovery-cases,plans,actions,outcomes,audit-log,exceptions,bandit-arms,users,relations,index}.ts` ·
`src/client.ts` · `src/table-names.ts` · `src/index.ts` ·
`src/scripts/{env,migrate,seed,verify}.ts` · `drizzle.config.ts` ·
`drizzle/0000_nifty_arclight.sql` · `package.json` · `tsconfig.json`

**packages/llm** — interface only
`src/provider.ts` · `src/index.ts` · `package.json` · `tsconfig.json`

**apps/web**
`src/app/{layout,page}.tsx` · `src/app/globals.css` ·
`src/app/login/{page,login-form,actions}.ts(x)` · `src/app/dashboard/page.tsx` ·
`src/app/api/auth/[...nextauth]/route.ts` · `src/auth.ts` · `src/auth.config.ts` ·
`src/middleware.ts` · `src/lib/{utils,policy}.ts` · `src/types/assets.d.ts` ·
`next.config.ts` · `postcss.config.mjs` · `components.json` · `next-env.d.ts` ·
`package.json` · `tsconfig.json`

**apps/worker** — scaffold
`src/index.ts` · `package.json` · `tsconfig.json`

**eval** — scaffold
`src/index.ts` · `src/seed.ts` · `package.json` · `tsconfig.json`

**docs**
`DECISIONS.md` (ADR-017 … ADR-025 appended) · `CLAUDE_CONTEXT.md` (this file)

---

## Architecture changes

None to the shape in `docs/ARCHITECTURE.md`. Two implementation choices worth
knowing before touching the code:

- **The purity rule is now enforced by the linter, not by discipline.**
  `eslint.config.mjs` blocks `fetch`, `process`, `fs`, `path`, `@reflow/db`,
  `drizzle-orm`, `Date.now()`, `Math.random()`, and bare `new Date()` inside
  `packages/core/src`. Exactly two files are exempt: `env/load.ts` and
  `policy/load.ts`. Verified by linting a deliberate violation and watching it
  fail. If you need the clock in core, take `now: Date` as a parameter.

- **Env and policy loading are split pure/impure** (ADR-017). Use `parseEnv` and
  `parsePolicy` from decision code and tests; use `getWebEnv`/`getWorkerEnv` and
  `loadPolicy` only at process edges.

---

## Schema changes

The nine tables in `docs/DATABASE_DESIGN.md` are implemented verbatim and applied
to Neon, plus one addition:

- **`users` added** (ADR-021) — dashboard login only. Not domain data. The
  database therefore has **ten** tables; `pnpm --filter @reflow/db verify` labels
  each one `domain` or `auth`.

Confirmed live in Neon: 10 tables, 33 indexes, all four `%_paise` columns are
`bigint`, `raw_events.provider_event_id` UNIQUE present,
`bandit_arms (bucket_key, arm)` UNIQUE present.

Migration file: `packages/db/drizzle/0000_nifty_arclight.sql`. Never edit it —
add a new migration.

---

## API changes

No business endpoints yet. Routes that exist:

| Route | Auth | Notes |
|---|---|---|
| `GET /` | public | Static. Reads **no** env — serves on an unconfigured deployment. |
| `GET /login` | public | `force-dynamic`. Credentials form. |
| `GET /dashboard` | **protected** | `force-dynamic`. Validates env, loads policy. |
| `/api/auth/*` | public | Auth.js handlers, Node runtime (bcrypt). |

`middleware.ts` matches `/dashboard/:path*` only, deliberately — `/` must stay
reachable with no environment configured.

`/api/webhooks/razorpay` does **not** exist yet. It is Run 2.

---

## Decisions made this run

Nine ADRs appended to `docs/DECISIONS.md`:

- **ADR-017** pure/impure split for env and policy loading
- **ADR-018** env validation memoised on first access, not at import
- **ADR-019** per-surface env schemas (least privilege as code)
- **ADR-020** money is `bigint` in Postgres, branded `number` in TypeScript
- **ADR-021** `users` table added outside the nine
- **ADR-022** extensionless relative imports in workspace packages
- **ADR-023** web app loads `.env.local` from the repository root
- **ADR-024** TypeScript pinned to 6.x so `typescript-eslint` runs
- **ADR-025** two secrets generated locally instead of halting

---

## Known issues

```
- [HIGH] Vercel deployment fails ~1s after creation, for every commit including
  a commit containing only .gitignore — apps/web — blocks next phase? NO for
  building, YES for the Run 2 webhook, which needs a live public URL.
- [LOW] pnpm prints a peer-dependency warning on install — cosmetic, no effect.
- [LOW] next-auth's `jose` dependency warns about DecompressionStream in the Edge
  runtime during build — a warning from a transitive dep, build succeeds.
```

### The Vercel failure, in detail

**Status:** three deployments, three failures, each recorded as failed **one
second** after being created.

| commit | deployment | result |
|---|---|---|
| `29a014c` (only `.gitignore`) | 6229490226 | failure in 1s |
| `85df792` (full app) | 6231142679 | failure in 1s |
| `f4716a8` (engines fix) | — | failure in 1s |

`https://razorpay-theta-ten.vercel.app` returns **404** — no production
deployment has ever succeeded.

**What was ruled out by actually testing it:**

- The build itself is fine. `pnpm build` succeeds locally.
- It is not missing env vars. The build was re-run with **only** `DATABASE_URL`
  and `AUTH_URL` set — exactly Vercel's current state — and succeeded, because
  `/` reads no env and `/dashboard` is `force-dynamic`.
- It is not the lockfile. `lockfileVersion: '9.0'`, and
  `pnpm install --frozen-lockfile` succeeds.
- It is not `engines.node`. The range was removed in `f4716a8`; still fails.
- It is not a missing root directory. `apps/web` is confirmed present in the
  pushed tree via the GitHub contents API.

**Why it could not be diagnosed further:** the Vercel CLI is logged out
(`npx vercel whoami` → "Logged out"), so the build logs are unreachable from this
session. A one-second failure across every commit — including one with no
application in it at all — points at project or account level rejection before
any build begins, not at repository content.

**What the human should check, in order:**

1. Run `npx vercel login`, then
   `npx vercel inspect dpl_HhxqUNj6J4b4zA57gg4VXMYsJQKH --logs`.
   That single command should name the cause outright.
2. In Vercel → Project → Settings → Build & Deployment, confirm **"Include source
   files outside of the Root Directory in the Build Step" is ENABLED.** This
   monorepo *requires* it: `apps/web` imports `../../packages/*` via
   `transpilePackages`, reads `../../policy.yaml`, and needs the root
   `pnpm-workspace.yaml` and `pnpm-lock.yaml` to install `workspace:*` deps. With
   this off, Vercel copies only `apps/web` and install fails almost immediately —
   which matches the one-second symptom exactly.
3. Confirm **Root Directory** is `apps/web` and the project is not paused or over
   its Hobby-plan build quota.

---

## Incomplete work

- **Vercel deployment is red.** Everything needed for it to go green is committed;
  the blocker is a Vercel-side setting or account state this session cannot read.
  See above.
- **`packages/llm` is interface-only.** `LlmProvider`, `CompletionResult`, and
  `InjectionVerdict` are defined and typechecked. No Groq client, no prompts, no
  injection screen, no response cache — all Run 3.
- **`eval/` is two placeholder scripts.** `pnpm eval` and `pnpm eval:seed` run,
  validate env, load policy, and print what they will do. No generator, no arms,
  no `RESULTS.md` — Run 7.
- **`apps/worker` is a boot check.** It validates env, loads policy, proves it can
  reach Neon, and exits. No ingest, diagnose, plan, schedule, execute, observe, or
  learn — Runs 2 to 5.
- **No shadcn/ui components installed.** The token set is in `globals.css` and
  `components.json` is configured, so `pnpm dlx shadcn@latest add <component>`
  works. Nothing was generated because Run 1 forbids UI beyond a bare page.
- **`docs/UI_DESIGN_SYSTEM.md` not applied.** Read it in Run 6 before styling.
- **No `pgboss.*` tables.** pg-boss creates its own schema; it arrives in Run 5.
- **`DEMO_TIME_SCALE` is validated but nothing consumes it.** The central
  scheduling helper is Run 5. Do not compute a delay at a call site.

---

## Verification performed

Every line below was run. Commands and results, not inspection.

```
1. .env.local ignored
   → git check-ignore -v .env.local
   → ".gitignore:7:.env*  .env.local", exit 0. PASS

2. No secret in git history
   → git log --all -p | Select-String "npg_|rzp_test_|gsk_"
   → 10 matches, exit 0. NOT EMPTY — but zero are real credentials.
     All 10 are: prefix checks in source (startsWith('rzp_test_')),
     fake test fixtures (rzp_test_FAKEKEY123456, gsk_fake000...),
     documentation prose, and the checklist's own grep pattern.
     "npg_" (the Neon password prefix) matched ZERO times.
   → Stronger check run instead: each live value from .env.local was
     searched for across `git log --all -p`. Every one absent, including
     the Neon password. Only .env.example is tracked. PASS on intent.

3. pnpm typecheck
   → clean across all 6 projects, exit 0. PASS

4. Migration applied to Neon — nine tables listed
   → pnpm --filter @reflow/db verify (queries information_schema)
   → merchants, raw_events, recovery_cases, plans, actions, outcomes,
     audit_log, exceptions, bandit_arms  [9/9 domain] + users [auth]
   → 33 indexes · 4/4 %_paise columns bigint ·
     raw_events.provider_event_id UNIQUE present · 1 merchant seeded
   → exit 0. PASS

5. pnpm dev serves a page at /
   → GET http://localhost:3000/ → 200, 17577 bytes, contains "Reflow". PASS

6. Login works with the seeded user
   → scripted against the running dev server:
     GET /dashboard signed out → 307 to /login?callbackUrl=... PASS
     POST /api/auth/callback/credentials, wrong password → no session. PASS
     POST with the seeded credential → authjs.session-token set. PASS
     GET /api/auth/session → demo@reflow.dev + merchantId. PASS
     GET /dashboard authenticated → 200, all 8 gate names rendered. PASS

7. policy.yaml loads and Zod-validates
   → pnpm test → packages/core/src/policy/load.test.ts reads the REAL
     policy.yaml at the repo root, not a fixture.
   → version 1.0.0, 8 gates, attempt_cap 3, cooling 4h, contact cap 3,
     quiet 21:00-09:00 Asia/Kolkata, ceiling 2500000 paise, pre-debit
     24h, attribution 72h, arms [2,6,18,48], 4 terminal causes. PASS
   → 70 tests total, 4 files, all passing, exit 0.

8. Env validation crashes when a variable is removed
   → removed GROQ_API_KEY from .env.local, ran the worker:
     "Invalid environment for \"worker (Railway)\". 1 problem(s):
        - GROQ_API_KEY: missing"  exit 1. PASS
   → restored; all 13 variables confirmed present; worker then booted,
     loaded policy 1.0.0, and reached Neon (SELECT 1 → 1), exit 0.
   → 28 further env tests assert every required variable crashes by name.

9. Push succeeded; Vercel status reported
   → git push origin main → 29a014c..85df792, then 85df792..f4716a8, exit 0
   → Vercel: FAILURE. See Known issues. Reported, not hidden.

Also run, beyond the required criteria:
   pnpm lint                → exit 0
   pnpm build               → exit 0 (Route /: static; /dashboard, /login: dynamic)
   pnpm build with ONLY DATABASE_URL + AUTH_URL → exit 0
   pnpm install --frozen-lockfile → exit 0
   purity fence probe       → Date.now() in core rejected by eslint, then deleted
```

---

## Git state

```
Last commit: f4716a8  fix(vercel): drop engines.node range that Vercel rejects at build init
Branch:      main
Pushed:      y  (origin/main == f4716a8)
History:     never rewritten, never force-pushed

Commits this run, in order:
  29a014c  chore: gitignore before anything else          <- alone, first, before any code
  72034dc  docs: specification baseline, policy, and env template
  bd12899  feat: pnpm monorepo with strict TS, pure core, drizzle schema, and tooling
  9d1d43d  feat(db): nine-table schema migrated to Neon, demo merchant seeded
  1d1e105  fix: extensionless relative imports so Next resolves workspace TS source
  85df792  feat(web): auth, protected dashboard, and monorepo-aware env and policy loading
  f4716a8  fix(vercel): drop engines.node range that Vercel rejects at build init

.env.local ignored and never committed:  verified — git check-ignore -v .env.local
                                         → .gitignore:7:.env*
Git identity: set LOCALLY for this repo only (PRCSM / noreply address).
              Global git config was NOT touched.
```

**Note on `.gitignore`:** `.env*` also matched `.env.example`, which the spec
requires to be tracked. A `!.env.example` negation was added on line 8. Verified
with `git ls-files --others --exclude-standard`: `.env.example` listed,
`.env.local` absent.

---

## Human action needed

**1 — Fix the Vercel deployment (blocks Run 2's webhook).**
Run `npx vercel login`, then
`npx vercel inspect dpl_HhxqUNj6J4b4zA57gg4VXMYsJQKH --logs`.
Most likely fix: enable **"Include source files outside of the Root Directory in
the Build Step"** in Project → Settings → Build & Deployment. This monorepo
cannot build without it.

**2 — Add the missing Vercel environment variables.** Only `DATABASE_URL` and
`AUTH_URL` are set. The build does not need more, but `/dashboard`, `/login`, and
the Run 2 webhook do. Vercel still needs:

```
RAZORPAY_KEY_ID            rzp_test_… from the Razorpay dashboard
RAZORPAY_KEY_SECRET        shown once at key generation
RAZORPAY_WEBHOOK_SECRET    copy the value already in .env.local
AUTH_SECRET                copy the value already in .env.local
DEMO_TIME_SCALE            1
POLICY_PATH                ./policy.yaml
```

Do **not** add `GROQ_API_KEY` to Vercel. It is worker-only by design, and the web
schema will reject the deployment's request for it as unnecessary — least
privilege, per `docs/ENVIRONMENT_VARIABLES.md`.

Also set `AUTH_URL` to `https://razorpay-theta-ten.vercel.app` (not localhost).

**3 — Note on two generated secrets.** `RAZORPAY_WEBHOOK_SECRET` and
`AUTH_SECRET` were blank in `.env.local` and were generated locally this run
(ADR-025). Neither has been printed anywhere. **In Run 2, register the webhook
using the `RAZORPAY_WEBHOOK_SECRET` value already in your `.env.local`** — do not
generate a new one, or every signature check will fail.

**After Run 2:** register the webhook URL in Razorpay. Run 2's report gives the
exact URL and event list.

**After Run 8:** run `docs/TESTING_GUIDE.md`.

---

## Dashboard login

```
URL       /login   (local: http://localhost:3000/login)
email     demo@reflow.dev
password  reflow-demo-2026
```

This default is **public in this repository**. It guards synthetic data only and
no PII, and judges need to sign in. To use a private credential instead:
`$env:SEED_USER_PASSWORD = '…'` then `pnpm db:seed` — the seed re-hashes on every
run, so rotation takes effect immediately.

---

## Next phase

**RUN 2 — Ingest.** Webhook receiver at `/api/webhooks/razorpay` with HMAC
verification and idempotency on `provider_event_id`, normalization of the four
sources into `recovery_cases`, and the deterministic synthetic generator.

**Webhook base URL, once the deploy is green:**
`https://razorpay-theta-ten.vercel.app`

---

## Running notes for future sessions

Traps a fresh session would otherwise hit the hard way:

- **`.gitignore` covering `.env*` is the first commit of Run 1, before any code.**
  Done. Keep the `!.env.example` negation on line 8 — without it the template is
  silently untracked.
- **`packages/core` must stay pure.** Now enforced by ESLint, not trust. Time is a
  parameter. Only `env/load.ts` and `policy/load.ts` are exempt; do not add a third.
- **All money is integer paise.** Use the `Paise` brand from `@reflow/core`.
  `paise()` throws on floats and negatives. The db verify script fails the build if
  a `%_paise` column is not `bigint`.
- **Neon needs the pooled connection string.** Enforced for `neon.tech` hosts only,
  so docker-compose Postgres still works. Region is `ap-southeast-1`.
- **`.env.local` is at the REPO ROOT, and Next looks in `apps/web`.** Handled in
  `next.config.ts` (ADR-023). `POLICY_PATH` has the same trap, handled in
  `apps/web/src/lib/policy.ts` by walking up from `cwd`. Any new app needs both.
- **Anything read at runtime must be added to `outputFileTracingIncludes`.** Next's
  tracing only sees imports. `policy.yaml` is already listed for `/dashboard`.
- **Do not write `.js` in relative imports** inside workspace packages (ADR-022).
  Next's webpack will not resolve it to `.ts`.
- **pnpm 11 replaced `onlyBuiltDependencies` with the `allowBuilds` map** in
  `pnpm-workspace.yaml`, and `strictDepBuilds` now defaults to true — an unapproved
  build script is a hard install failure. `esbuild` is already allowed; tsx and
  vitest cannot start without it.
- **TypeScript is pinned to 6.0.3** (ADR-024). Bumping to 7.x breaks
  `typescript-eslint` and therefore the purity fence.
- **Groq free tier binds on TPM (8,000/min), not RPD.** Hitting limits during eval
  means the rule table is too thin — a design smell, not a quota problem. Cache LLM
  responses by input hash.
- **Guardrails re-run at execution time**, not only at planning. A plan made at
  20:00 for 02:00 that fires at 09:30 must be re-checked.
- **`DEMO_TIME_SCALE`** compresses all scheduling delays for the video. One central
  helper; no call site computes a delay independently. Retrofitting means touching
  every call site.
- **Never claim a completion criterion passed without running it.** The human tests
  once, at the end. A false pass here surfaces on Day 6 with no time to fix it.
