# DECISIONS

Architecture decision records. Settled decisions — **do not relitigate** unless new information genuinely forces it.

Format: Decision · Context · Options · Chosen · Reason · Trade-offs · Consequences

---

## ADR-001 — Track 03, AI Revenue Recovery

**Context.** Five tracks. Solo builder with production payments experience (escrow, KYC, webhook hardening). Six days.

**Options.** (1) Agentic Commerce (2) Risk Manager (3) Revenue Recovery (4) Finance Controller (5) Open.

**Chosen.** Track 03.

**Reason.** Only track whose outcome is a rupee number. Directly reuses existing payments experience. Track 01 will attract the largest field and is hardest to prove value in. Track 02 needs labelled data and real ML depth. Track 04 is winnable but has a lower ceiling.

**Trade-offs.** Broader scope than Track 04. More surface to get wrong.

**Consequences.** The eval harness is not optional — the entire pitch rests on a measured number.

---

## ADR-002 — Four surfaces, two at full depth

**Context.** The track lists five recovery surfaces. ~40 usable hours.

**Options.** (a) One surface, very deep (b) Two full (c) All four full (d) All four, varying depth.

**Chosen.** (d). Payments and mandates at full policy depth; checkout abandonment and receivables light.

**Reason.** One `RecoveryCase` abstraction carries all four through the same pipeline, so breadth is cheap. Depth is the expensive part, so it's spent where the money is. "Four surfaces, one engine" is a stronger claim than four thin ones — and the bar explicitly punishes shallow work.

**Trade-offs.** Two surfaces are visibly lighter. Must be disclosed, not hidden.

**Consequences.** README states which surfaces are full-depth. Cut order under pressure: receivables → checkout → bandit → Hinglish.

---

## ADR-003 — Two-lane data strategy

**Context.** Razorpay test mode cannot produce 500 realistic failures with ground truth. Honest precision/recall requires ground truth.

**Options.** (a) Live only — no real metrics (b) Synthetic only — no real integration (c) Both, disclosed (d) Both, blended silently.

**Chosen.** (c).

**Reason.** (d) is dishonest and, if spotted, discredits every number. (a) and (b) each give up half of what the track asks for. Disclosure converts a limitation into a credibility signal.

**Trade-offs.** Requires building and documenting a generator. A judge may discount synthetic numbers — correctly.

**Consequences.** `is_synthetic` on every case. `EVAL_METHODOLOGY.md` states the split. Disclosure sits at the top of the README, not in a footnote.

---

## ADR-004 — Hosting: Vercel + Neon + one Railway worker

**Context.** Cost matters. The scheduler needs a persistent process; Vercel functions are request-scoped.

**Options.** (a) All Railway (b) Vercel + Neon + Railway worker (c) All Vercel with cron (d) Fly.io.

**Chosen.** (b).

**Reason.** All-Railway costs roughly $12–18/month across three always-on services — the $5 trial credit lasts under two weeks, and judging may run past submission. The split keeps web and database on free tiers and puts only the worker (~$3–5) on Railway, covered by trial credit. Total: ~$0–5. (c) fails because minute-granularity stateless cron cannot run a durable scheduler without reimplementing one badly.

**Trade-offs.** Two deploy pipelines, two env-var sets. One-time setup cost, not recurring.

**Consequences.** `ENVIRONMENT_VARIABLES.md` maps every variable to its home. Webhook endpoint lives on Vercel; the worker has no public inbound surface.

---

## ADR-005 — pg-boss over Redis/BullMQ

**Context.** Need delayed jobs, retries, durability. ~500 jobs, not 500k.

**Options.** (a) BullMQ + Redis (b) pg-boss on the existing Postgres (c) hand-rolled polling.

**Chosen.** (b).

**Reason.** One fewer account, one fewer service, one fewer failure mode. Jobs share a transaction boundary with the audit log. Throughput ceiling is irrelevant at this scale.

**Trade-offs.** Lower ceiling than Redis. Polling-based, so sub-second precision isn't guaranteed — irrelevant when delays are measured in hours.

**Consequences.** Job durability comes free: a scheduled job survives worker restarts because it's a database row.

---

## ADR-006 — Always-on containers, not scale-to-zero

**Context.** Railway's Serverless mode is opt-in and sleeps a service after 5–10 minutes without outbound traffic.

**Options.** (a) Serverless on, save cost (b) Always on (c) External cron ping to keep it awake.

**Chosen.** (b), plus application-layer durability.

**Reason.** A sleeping worker misses scheduled retries — that breaks the core product. (c) is a hack that costs nearly as much as staying awake. A judge hitting a cold boot is a bad first impression.

**Trade-offs.** ~$3–5/month instead of near-zero.

**Consequences.** Durability is handled in the app, not the platform: jobs in Postgres, catch-up pass on boot, guardrails re-run at execution, `lag_seconds` recorded and surfaced. The system survives downtime rather than assuming it won't happen.

---

## ADR-007 — Groq free tier, provider abstracted

**Context.** LLM needed for tail diagnosis, explanations, outreach copy. Budget ₹0.

**Options.** (a) Anthropic API (b) OpenAI (c) Groq free tier (d) local model.

**Chosen.** (c), behind an `LLMProvider` interface with model names in env vars.

**Reason.** Free with no card. GPT-OSS 120B is comfortably strong enough for constrained classification and short copy. Sub-100ms time-to-first-token makes the dashboard feel instant on video. Llama Prompt Guard 2 gives a purpose-built injection filter on the same platform.

**Trade-offs.** Open-weight models are less rigorous at strict JSON schema than frontier models — mitigated by Zod plus one retry. Free catalogs change without notice; providers have removed free models with no warning. Hinglish quality is unproven and must be tested early.

**Consequences.** Every model name is an env var. Swapping providers is config, not refactor. Responses cached by input hash — deterministic re-runs, no quota burn.

---

## ADR-008 — Prompt Guard as gate 0

**Context.** The system ingests merchant- and customer-supplied text and feeds it to a model that influences money decisions.

**Options.** (a) Trust the input (b) Regex/heuristic filtering (c) A dedicated injection classifier.

**Chosen.** (c) — Llama Prompt Guard 2, first gate in the chain.

**Reason.** A real threat surface, not a theoretical one. Free on the same platform, fast, purpose-built. Regex filtering of natural language injection doesn't work.

**Trade-offs.** One extra call per untrusted field. False positives route legitimate cases to exceptions.

**Consequences.** Runs before any other LLM call. Detection flags the case and skips the LLM entirely.

---

## ADR-009 — `packages/core` is pure

**Context.** The eval harness claims to measure the system that actually runs. That's only true if both execute the same code.

**Options.** (a) Pure core shared by both (b) Separate eval implementation (c) Eval calls the live worker.

**Chosen.** (a). No I/O, no fetch, no db, no `Date.now()` inside decision functions — time passed in.

**Reason.** (b) measures something that isn't the product. (c) is slow, non-deterministic, and untestable. Purity is what makes the metrics defensible.

**Trade-offs.** Some ceremony threading time and config through function signatures.

**Consequences.** The most important constraint in the codebase. Violating it invalidates `RESULTS.md`. Enforced in `INSTRUCTIONS.md` and in review.

---

## ADR-010 — Drizzle over Prisma

**Chosen.** Drizzle.

**Reason.** SQL-close, which matters because there are real analytical recovery queries. First-class `jsonb` — this schema stores a lot of it. No generate step slowing the Claude Code edit loop.

**Trade-offs.** Smaller ecosystem, thinner docs, more manual migration review.

**Consequences.** `packages/db` is the only place SQL lives.

---

## ADR-011 — Rule engine decides, LLM explains

**Context.** Diagnosis could be LLM-first or rules-first.

**Options.** (a) LLM classifies everything (b) Rules only (c) Rules first, LLM on the tail.

**Chosen.** (c).

**Reason.** Razorpay error codes are a finite, documented set — a lookup table handles the bulk deterministically. An LLM owning classification is non-deterministic, unauditable, quota-bound, and the first thing a judge will attack. (b) can't handle unmapped tuples.

**Trade-offs.** The rule table is manual work and needs maintenance.

**Consequences.** `cause_by` recorded per case; the rule-vs-LLM split is reported. A high LLM share is treated as a negative signal about rule coverage.

---

## ADR-012 — Bandit behind a strategy interface, static ships first

**Chosen.** `TimingStrategy` interface. `StaticTimingStrategy` default, `BanditTimingStrategy` config-selected.

**Reason.** Ships something working immediately and makes learning a clean addition rather than a rewrite. It is also the first thing cut if time runs out.

**Trade-offs.** Slight indirection before it's needed.

**Consequences.** Empty bandit table degrades to the static table. The eval can compare both strategies as a bonus finding.

---

## ADR-013 — Auth: seeded merchant, credential login, no signup

**Chosen.** Auth.js credentials provider, one seeded user, `/dashboard/*` protected, `/` public.

**Reason.** Judges need to log in and look around. They don't need an org invite flow. Roughly two hours, and an unprotected dashboard looks unfinished.

**Consequences.** `merchant_id` is on every table so multi-tenancy is modelled; RLS is not enabled. Documented as modelled-not-enforced.

---

## ADR-014 — Modular monolith, two deployables

**Chosen.** Shared core, two deployed processes, one database.

**Reason.** The split exists for exactly one reason: the scheduler needs a long-running process and Vercel functions are request-scoped. No other justification is claimed, and none is needed.

**Consequences.** No service mesh, no inter-service API, no distributed tracing. The database is the integration point.


---

## ADR-015 — Autonomous AI execution

**Context.** Six days, solo, and the human's time is better spent on the video, the form, and a single thorough test pass than on reviewing code they didn't write.

**Options.** (a) Approval gate at every phase (b) Fully autonomous, human tests at the end (c) Autonomous with self-verification and a HALT protocol.

**Chosen.** (c).

**Reason.** (a) makes the human the bottleneck and wastes their limited hours on review they aren't positioned to do well. (b) is reckless — an unverified phase silently poisons every phase after it, and nobody finds out until Day 6. (c) keeps the throughput of full autonomy while replacing human approval with machine verification: explicit completion criteria, each verified by actually running it, self-correction on failure, and a hard stop when self-correction fails twice.

**Trade-offs.** A wrong architectural interpretation in an early phase propagates further before anyone catches it. Mitigated by phase reports, `CLAUDE_CONTEXT.md`, and the human skimming three specific signals: the Day 1 distribution breakdown, the Day 2 rule-vs-LLM split, and the Day 5 arm comparison.

**Consequences.** `docs/INSTRUCTIONS.md` defines the HALT protocol and the self-verification loop. Every run block carries explicit, runnable completion criteria. `docs/TESTING_GUIDE.md` exists because the human tests exactly once.

---

## ADR-016 — Claude Code owns git

**Context.** The human asked not to manage commits. The repository must be public for submission and `.env.local` holds a live database credential with full read/write/drop.

**Options.** (a) Human commits manually (b) Claude Code commits, human pushes (c) Claude Code owns the full git lifecycle.

**Chosen.** (c), with `.gitignore` as the mandatory first commit of Run 1.

**Reason.** Splitting responsibility for git is how secrets leak — each party assumes the other checked. Full ownership makes the protection unambiguous and puts it before any code exists to accidentally reference a secret.

**Trade-offs.** Requires non-interactive push auth configured before Run 1. A push failure mid-phase is a HALT.

**Consequences.** `.gitignore` covering `.env*` is committed alone, first, verified with `git check-ignore`. Every phase-ending commit is preceded by a `git diff --cached` scan for secret-shaped strings. History is never rewritten and never force-pushed.

---
## ADR-017 — Env and policy loading split into a pure half and a boundary adapter
**Context.** Run 1's TASK 3 and TASK 4 place env validation and the `policy.yaml` loader inside `packages/core`, at `core/env` and `core/policy/load.ts`. But ADR-009 makes `packages/core` pure: no filesystem, no `process`, no clock. Reading `policy.yaml` needs `fs`; reading env needs `process.env`. Taken literally, the two requirements contradict.
**Options.** (a) Put the loaders in `apps/` and violate the specified paths. (b) Put them in core and quietly relax the purity rule. (c) Split each into a pure validator plus a thin, explicitly documented boundary adapter in the specified location.
**Chosen.** (c). `env/schema.ts` exposes `parseEnv(schema, source, surface)` and `policy/schema.ts` exposes `parsePolicy(raw)` — both pure, both taking data and returning data. `env/load.ts` and `policy/load.ts` are the only impure files in core, contain no decision logic, and are the only two paths exempted from the purity fence in `eslint.config.mjs`.
**Reason.** Purity exists so the eval harness and the live worker execute identical code. A validator that takes its input as an argument satisfies that completely; the file read does not participate in any decision. This keeps the specified paths, keeps the rule meaningful, and lets the eval harness validate an in-memory policy without touching disk.
**Trade-offs.** Two files per concern instead of one, and a reader must know which half is which. The exemption list in the lint config must be kept to exactly these two files, or the fence erodes.
**Consequences.** The purity fence is enforced by ESLint (`no-restricted-globals`, `no-restricted-imports`, `no-restricted-properties`, and a `no-restricted-syntax` rule banning bare `new Date()`), verified in Run 1 by a probe file that was linted, confirmed to fail, and deleted.

---
## ADR-018 — Env validation is memoised on first access, not at module import
**Context.** `docs/ENVIRONMENT_VARIABLES.md` requires a crash at startup on a missing variable, and forbids `?? 'default'` fallbacks. But Next.js imports every module while building, so validating at import time makes a production build require live secrets on a build machine that legitimately has none.
**Options.** (a) Validate at module import and give Vercel every secret before the first deploy. (b) Add build-time escape hatches or fallbacks. (c) Validate on first access and memoise.
**Chosen.** (c).
**Reason.** (b) is precisely the failure mode the document warns about. (c) changes *when* validation runs, not *whether* it runs or *what* it accepts: the schema is identical and a missing variable still throws by name before any code can read it. "Startup" becomes process startup rather than bundler evaluation.
**Trade-offs.** A misconfigured variable surfaces on the first request that needs it rather than at boot. Mitigated because the landing page deliberately reads no env, so a misconfigured deployment is obvious the moment `/dashboard` is opened.
**Consequences.** `getWebEnv()`, `getWorkerEnv()`, `getFullEnv()`, and `getDbEnv()` are memoised accessors. `/dashboard` is `force-dynamic` so it is never prerendered. Verified in Run 1 by deleting `GROQ_API_KEY` and confirming the worker refused to start, naming the variable.

---
## ADR-019 — Per-surface env schemas rather than one global schema
**Context.** TASK 3 asks for validation of every variable in `.env.example`. The map in `docs/ENVIRONMENT_VARIABLES.md` gives each surface a different subset: `GROQ_API_KEY` is worker-only, `RAZORPAY_WEBHOOK_SECRET` and `AUTH_*` are web-only.
**Options.** (a) One schema requiring everything everywhere. (b) One schema with everything optional. (c) Separate `webEnvSchema`, `workerEnvSchema`, `dbEnvSchema`, and a `fullEnvSchema`.
**Chosen.** (c).
**Reason.** (a) would force the Groq key into Vercel, contradicting the least-privilege intent the document states explicitly — a surface that cannot read a key cannot leak it. (b) abandons the guarantee entirely. (c) implements the documented map as code.
**Trade-offs.** Four schemas to keep in step with `.env.example`. `fullEnvSchema` covers the whole file for tooling and the eval harness, so nothing is unvalidated.
**Consequences.** `DATABASE_URL` requires the `-pooler` host segment only for `neon.tech` hosts, so the docker-compose Postgres in TASK 6 remains usable. `RAZORPAY_KEY_ID` must start `rzp_test_`; a live key is rejected outright, because this system takes money actions autonomously.

---
## ADR-020 — Money columns are `bigint` in Postgres, `number` in TypeScript
**Context.** `docs/DATABASE_DESIGN.md` requires `bigint` paise columns. Postgres `bigint` exceeds JavaScript's safe integer range, and Drizzle can surface such a column as either `bigint` or `number`.
**Options.** (a) `mode: 'bigint'` and convert at every read and write. (b) `mode: 'number'` with a range-checked domain type.
**Chosen.** (b). The column type stays `bigint` exactly as specified; the JavaScript representation is a branded `Paise` type whose ceiling is `Number.MAX_SAFE_INTEGER`.
**Reason.** The safe-integer ceiling is about ₹90 trillion — orders of magnitude above any payment this system will ever see. (a) would add a conversion at every boundary for a range that cannot occur, and every conversion is a place to get it wrong.
**Trade-offs.** A value above 2^53 paise would lose precision. `paiseFromBigInt` and `paiseToBigInt` exist for the boundary and throw on out-of-range values rather than silently truncating.
**Consequences.** `packages/core/src/money.ts` brands `Paise`, rejects floats and negatives, and is covered by tests asserting the rejection paths. A `verify` script queries `information_schema` and fails if any `%_paise` column is not `bigint`.

---
## ADR-021 — A `users` table, outside the nine documented tables
**Context.** TASK 5 requires an Auth.js credentials provider with one seeded user. A credentials provider needs a password hash to compare against. `docs/DATABASE_DESIGN.md` specifies nine tables and none of them holds users.
**Options.** (a) Hardcode the credential in env and skip the table. (b) Add a minimal `users` table. (c) Extend `merchants` with auth columns.
**Chosen.** (b).
**Reason.** (a) puts a bcrypt hash in an env var and makes rotation a redeploy. (c) conflates a tenant with an operator. (b) is the smallest honest addition, and the schema document describes the *recovery domain* — dashboard login is infrastructure, not domain data.
**Trade-offs.** The database now has ten tables, so "nine tables" needs qualifying whenever the schema is described. The verify script labels each table `domain` or `auth` to keep the distinction visible.
**Consequences.** `users` holds a bcrypt hash at cost 12, has no signup flow, no password reset, and no sessions table (Auth.js uses a JWT strategy). The seed re-hashes on every run so rotating `SEED_USER_PASSWORD` takes effect.

---
## ADR-022 — Extensionless relative imports in workspace packages
**Context.** The workspace packages export TypeScript source directly and Next compiles them through `transpilePackages`. Node-ESM convention writes relative imports with a `.js` suffix; Next's webpack resolver will not map `./money.js` onto `./money.ts`, so the web build failed with unresolved-module errors while `tsc`, `tsx`, and Vitest all succeeded.
**Options.** (a) Add `resolve.extensionAlias` to the webpack config. (b) Build each package to `dist` and consume the output. (c) Drop the `.js` suffix and rely on `moduleResolution: "bundler"`.
**Chosen.** (c), applied across all five source packages.
**Reason.** (a) is bundler-specific and would break the moment anything switches to Turbopack. (b) adds a build step to every package and breaks the property that the worker, the eval harness, and the web app consume identical source. (c) is the idiomatic form under `moduleResolution: "bundler"` and resolves correctly in every tool already in use.
**Trade-offs.** The packages can no longer be executed by bare Node ESM without a resolver. Nothing does — `tsx` runs the worker and the scripts, Vitest runs the tests, Next builds the web app.
**Consequences.** 61 specifiers across 27 files were rewritten by a one-shot codemod, which was then deleted. Typecheck, all 70 tests, and the production build were re-verified afterwards.

---
## ADR-023 — The web app loads `.env.local` from the repository root
**Context.** Next.js resolves `.env.local` against the app root (`apps/web`), but the single source of truth is at the monorepo root. The web app therefore started with no environment at all — and because the landing page deliberately reads no env, `/` still worked and the problem was invisible until `/dashboard` was opened.
**Options.** (a) Copy or symlink `.env.local` into `apps/web`. (b) Load the root file explicitly in `next.config.ts`. (c) Move `.env.local` into `apps/web` and have the worker reach sideways for it.
**Chosen.** (b).
**Reason.** (a) duplicates a live credential and invites drift between two copies. (c) breaks the worker and the database scripts, which also read the root file. (b) keeps one file and one truth. `dotenv` does not overwrite variables that are already set, so platform values always win on Vercel and Railway, and the call is a silent no-op where the file is absent.
**Trade-offs.** Env loading now happens in a config file, which is a slightly unusual place to look for it. Documented in a comment at the call site.
**Consequences.** `POLICY_PATH` has the same class of problem, solved separately: `apps/web/src/lib/policy.ts` resolves a relative policy path by walking up from `cwd`, and `outputFileTracingIncludes` pulls `policy.yaml` into the serverless bundle, since a file read at runtime is invisible to Next's dependency tracing.

---
## ADR-024 — TypeScript pinned to 6.x, not 7.x
**Context.** The environment installed TypeScript 7.0.2 by default. `typescript-eslint` 8.69 refuses to run against the TS 7 API, so `pnpm lint` failed outright — and with it the purity fence, which is the most important constraint in the codebase.
**Options.** (a) Keep TS 7 and drop typescript-eslint, losing the TypeScript parser and therefore all linting of `.ts` files. (b) Keep TS 7 and run typescript-eslint against a side-by-side TS 6 install. (c) Pin TypeScript to 6.0.3 everywhere.
**Chosen.** (c).
**Reason.** (a) trades a working guardrail for compile speed, which is the wrong direction on a six-day build where the fence is load-bearing. (b) means two TypeScript versions in one repo and a subtle mismatch between what typechecks and what lints. Every compiler option this project uses is supported by TS 6, and Next 15 targets the 5.x/6.x line.
**Trade-offs.** Forgoes the native compiler's speed. Typecheck across six projects runs in seconds, so this costs nothing measurable.
**Consequences.** `typescript: 6.0.3` is pinned in all seven package manifests. `declaration` is also off in `tsconfig.base.json`: nothing in the repo emits, and leaving it on triggers declaration-portability errors (TS2883) on library types that cannot be named from a pnpm store path.

---
## ADR-025 — Two secrets generated locally rather than halting
**Context.** `docs/ENVIRONMENT_VARIABLES.md` states the human fills `RAZORPAY_WEBHOOK_SECRET` and `AUTH_SECRET` before Run 1. Both were empty when Run 1 started, and the env validator correctly refused to start without them.
**Options.** (a) HALT under reason 1, credential missing. (b) Generate both locally and flag it.
**Chosen.** (b).
**Reason.** Neither value is issued by a third party. The document itself specifies how to produce them — `openssl rand -hex 32` and `openssl rand -base64 32` — so nothing was missing that only the human could supply, and halting would have cost the run for a step that takes one command. HALT reason 1 covers a credential that is absent, expired, or rejected by a service; this was neither.
**Trade-offs.** The human must use the generated `RAZORPAY_WEBHOOK_SECRET` when registering the webhook in Run 2 rather than inventing a new one, or signature verification will fail on every delivery.
**Consequences.** Both were written to the gitignored `.env.local` with Node's `crypto.randomBytes`, and neither value has been printed to a log, a commit, a document, or a phase report. Both must also be set in Vercel before the dashboard will serve.

---
## ADR-026 — The synthetic generator was corrected to the canonical taxonomy
**Context.** Run 3 opened with a direct conflict. `docs/POLICY_SPEC.md` §1 defines a CLOSED root-cause taxonomy of 21 values and states that nothing outside it is ever valid. The Run 2 generator emitted its own vocabulary for three of the four surfaces: mandates got `mandate_pre_debit_missing`, `mandate_paused`, and bare `insufficient_funds`; checkout got `checkout_abandoned_price` / `_friction` / `_distraction`; receivables got `invoice_overdue`, `invoice_disputed`, `invoice_awaiting_po`. None of those are legal causes. That is 45% of the dataset — mandate 20%, checkout 15%, receivable 10% — labelled with values the rule engine is forbidden to return, which makes scoring those lanes structurally impossible rather than merely inaccurate.
**Options.** (a) Widen the rule table to emit the generator's vocabulary. (b) Add a translation layer between the two. (c) Correct the generator to the canonical taxonomy.
**Chosen.** (c).
**Reason.** POLICY_SPEC is the authority and says so explicitly; the generator is downstream of it. (a) would abandon the closed-taxonomy guarantee, which is the thing that stops the LLM inventing causes. (b) would hide the inconsistency behind a mapping nobody would maintain, and a translation layer between an oracle and the system it scores is exactly where a metric goes quietly wrong. Correcting the ORACLE to emit legal labels is not the same as tuning the RULES to match the oracle — the prohibition in TASK 7 is against the latter, and the rule table was still written from POLICY_SPEC and Razorpay error semantics before it was ever scored.
**Trade-offs.** The dataset fingerprint changed (`ea588ebc96433e73`), so Run 2's recorded fingerprint no longer reproduces. Acceptable: the dataset is regenerable by design and no measured result had been published from it.
**Consequences.** `packages/core/src/diagnose/taxonomy.ts` is now the single source of truth, imported by the rule engine, the LLM prompt, the Zod response schema, and the generator, so the label sets cannot drift again. A test asserts the exact contents of all five groups against POLICY_SPEC, and another asserts the Run 2 vocabulary is rejected.

---
## ADR-027 — Checkout abandonment carries a stage signal, not a provider error
**Context.** Razorpay emits no "customer left" event, so `checkout.abandoned` is our own simulated event. Run 2 gave those cases null error fields, which left the rule table nothing to match on — every checkout case would have fallen to the LLM.
**Options.** (a) Leave the fields null and let the LLM classify all checkout cases. (b) Record the funnel stage the customer reached in the existing error fields.
**Chosen.** (b): `error_code = 'CHECKOUT_ABANDONED'`, `error_source = 'customer'`, and `error_step` set to `checkout_method_selection`, `checkout_authentication`, or `checkout_review`.
**Reason.** We own the event, so we legitimately know where the customer stopped — that is observed data, not an inference. (a) would hand a light-depth surface entirely to the LLM, which inverts the rule POLICY_SPEC §6 exists to enforce, and would spend Groq quota on the easiest classification in the system.
**Trade-offs.** `error_code` now carries a value that did not come from a provider. Mitigated by the marker being obviously ours rather than a Razorpay code, and by `raw_events.event_type` recording `checkout.abandoned` so the simulated lane stays visible.
**Consequences.** The three checkout causes map deterministically from the stage. A Run 2 test asserting "checkout cases carry no provider error code" was updated to assert the stage signal instead.

---
## ADR-028 — Days-overdue is carried in `error_reason`, not a new column
**Context.** `overdue_soft` (<15 days) and `overdue_hard` (≥15 days) are the same provider signal split by a day count, so diagnosis needs the age of the invoice. `recovery_cases` has no such column.
**Options.** (a) Add an `days_overdue` column. (b) Encode it in `error_reason` as `invoice_past_due_date:<n>`. (c) Derive it at diagnosis time from `opened_at`.
**Chosen.** (b).
**Reason.** (c) is wrong: `opened_at` is when we noticed the invoice expired, not when it became due, so it would measure our own latency. (a) is the cleanest model but costs a migration for one light-depth surface, and the value is genuinely a detail of the provider's reason rather than a first-class domain attribute. (b) gives both lanes one field populated the same way — the generator writes it, and the live normalizer computes it from the invoice's due date.
**Trade-offs.** A structured value inside a free-text field, which is the kind of thing that rots. Contained by `parseDaysOverdue` being the only reader, with tests for every malformed form.
**Consequences.** The rule engine falls back to parsing `error_reason` when `daysOverdue` is not supplied. An overdue invoice with no readable day count matches no rule and goes to the LLM tail, which is the correct outcome rather than a guessed threshold.

---
## ADR-029 — Razorpay downtime events as a first-class diagnosis signal
**Context.** The registered webhook receives `payment.downtime.started`, `.updated`, and `.resolved`. Razorpay reports issuer outages directly, with a start, an end, an affected rail, and a severity. Until Run 3, `issuer_down` was inferred solely from a `GATEWAY_ERROR` tuple.
**Options.** (a) Ignore the events and keep inferring. (b) Replace the inference path with the downtime signal. (c) Add the signal as a higher-precedence path and keep inference intact.
**Chosen.** (c), with a new `cause_by` value `downtime_signal` alongside `rule` and `llm`.
**Reason.** A confirmed outage window is an OBSERVATION with a timestamp; an error code is an inference about one. When both are available the observation should win, and it should be distinguishable in the data so RESULTS.md can report how much of `issuer_down` was measured versus deduced. (b) is not an option: the synthetic lane contains no downtime events, so removing inference would leave 38 synthetic `issuer_down` cases undiagnosable and would make the eval unable to exercise the path that runs when Razorpay has not reported an outage.
**Trade-offs.** An unresolved window matches every later failure on that issuer indefinitely, so a missed `.resolved` delivery would over-attribute `issuer_down`. Mitigated by `findStaleOpenWindows`, which surfaces any window open beyond 24h; deliberately NOT auto-closed, since inventing an end time would fabricate data.
**Consequences.** New table `downtime_windows`, keyed UNIQUE on `provider_downtime_id` so `.updated` and `.resolved` upsert one row per outage. Diagnosis prefers the most specific matching window (issuer+rail over platform-wide). Verified end to end against persisted rows: a failure inside the window reads `issuer_down` / `downtime_signal` / 1.0, and the identical tuple outside it reads `insufficient_funds` / `rule`.

---
## ADR-030 — Explanations are generated worker-side, lazily, per case
**Context.** TASK 5 requires the plain-English "why this failed" text to be generated on dashboard view, never for the batch — 500 cases against an 8,000 TPM ceiling is roughly 100 minutes. But `GROQ_API_KEY` is worker-only and must never be added to Vercel, so the web app cannot make an LLM call at all.
**Options.** (a) Add the Groq key to Vercel. (b) Pre-generate explanations for every case in the worker. (c) Generate lazily in the worker, one case at a time, and have the dashboard read what exists.
**Chosen.** (c).
**Reason.** (a) is explicitly forbidden and would break the least-privilege boundary that means a compromised web surface cannot leak the key — the typechecker enforces it, since `webEnvSchema` has no Groq key at all. (b) is the exact cost TASK 5 exists to avoid. (c) keeps both properties: nothing is pre-generated, and the key stays on one surface.
**Trade-offs.** The dashboard cannot generate an explanation synchronously on first view; Run 6 will either surface the cached text or trigger the worker. Called out rather than papered over.
**Consequences.** `explainOneCase` refuses to explain a case whose cause is null or `unknown`, because explaining an absent diagnosis is the model speculating. Explanations share the `llm_cache`, so a second view costs nothing and the wording is stable between loads — verified: `newApiCalls=0` and identical text on re-view.

---
## ADR-031 — Prompt Guard is called as a text classifier, not a chat model
**Context.** Gate 0 screens all untrusted text through `LLM_MODEL_GUARD`. The first implementation sent a system prompt plus a fenced user message, as for any chat model. Every guard call failed with HTTP 400: *"messages must contains a single user message for text classification models"*. Because failed calls are not cached, this also broke the "zero new API calls on re-run" property, which is how the bug was noticed.
**Options.** (a) Swap `LLM_MODEL_GUARD` for a general chat model and prompt it to classify. (b) Call Prompt Guard the way it expects.
**Chosen.** (b): exactly one user message containing only the text to classify, no system prompt, no fence.
**Reason.** Prompt Guard 2 is a purpose-built injection classifier and is far more reliable at this than a general model told to behave like one. Anything added to the message becomes part of what gets classified, so the fence was actively skewing the score.
**Trade-offs.** The response is a bare probability string (`"0.9995654225349426"` for an attack, `"0.0005332987"` for benign — verified live), not a label, so the parser is model-shaped. Since `LLM_MODEL_GUARD` is configurable, label-based fallbacks are retained for a differently-behaved model.
**Consequences.** `GroqClient.complete` now takes an optional `system`. `scoreFromGuardOutput` rejects an empty or unparseable response as `null` rather than parsing it as 0 — `Number('')` is 0, which would have read as "definitely benign" and failed the screen OPEN. The heuristic pre-screen runs first and fails CLOSED, so gate 0 still works when Groq is unreachable; a security control that fails open the moment its API is down is not a control.
