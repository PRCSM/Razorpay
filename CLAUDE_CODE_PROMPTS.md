# CLAUDE_CODE_PROMPTS

Eight runs. **Your only job is to paste one block per fresh Claude Code chat.**

Each run plans, builds, tests itself, fixes its own failures, updates docs, commits, and pushes. No approval gates. It stops only on a HALT condition.

**Rules:**
- One fresh chat per run. Never paste Run N+1 into the chat that just finished Run N — context bloat is what makes Claude Code start guessing.
- Wait for the `PHASE COMPLETE` report before starting the next run.
- If you get a `HALT`, it tells you exactly what it needs and exactly what to paste to resume.
- The only manual step in the whole sequence is the webhook URL, after Run 2.

---

## Standard preamble

Already embedded in every block below. Repeated here so you know what each run carries:

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first — it defines the HALT
protocol, git ownership, self-verification loop, and phase report format.
Do not ask permission to proceed. State your plan in one paragraph for the
record, then begin immediately. Verify every completion criterion by
actually running it. Commit and push. End with the PHASE COMPLETE report.
```

---

## RUN 1 — Foundation

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first — it defines the HALT
protocol, git ownership, self-verification loop, and phase report format.
Do not ask permission to proceed. State your plan in one paragraph, then
begin immediately.

ROLE: Staff engineer on Reflow, a payment-recovery agent for the Razorpay
Buildathon (Track 03: AI Revenue Recovery). Solo project, 6-day deadline,
you are doing all the development.

WHAT REFLOW IS
An agent that watches failed payments in real time, diagnoses WHY each
failed, picks the cheapest intervention likely to work, executes it inside
hard guardrails, and reports measured money recovered against a baseline.
Four recovery surfaces share one engine: payments and mandates at full
policy depth; checkout abandonment and B2B receivables at light depth.

CONTEXT
This repo already contains README.md, START_HERE.md, BUILD_PLAN.md,
policy.yaml, .env.local (filled), .env.example, and docs/ (11 files).
They are the specification. Read them, implement against them, do not
rewrite them.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/ARCHITECTURE.md
  docs/DATABASE_DESIGN.md
  docs/ENVIRONMENT_VARIABLES.md
  policy.yaml

OBJECTIVE
Repository foundation: git safety, monorepo, database schema, auth,
tooling. No business logic.

=== TASK 0 — DO THIS BEFORE ANYTHING ELSE ===
Write .gitignore covering: .env*, node_modules, .next, dist, build,
.turbo, coverage, *.log
Commit it ALONE as the first commit: "chore: gitignore before anything else"

.env.local contains a LIVE Neon database password with full read/write/drop
and THIS REPO IS PUBLIC. If it reaches a commit the credential is exposed
to the internet. Verify with `git check-ignore -v .env.local` before you
write another line of code.

=== TASK 1 — MONOREPO ===
pnpm workspace, TypeScript strict everywhere.
  apps/web/         Next.js 15 App Router, TS, Tailwind, shadcn/ui init
  apps/worker/      Node + TS, tsx for dev, entrypoint only
  packages/core/    pure domain logic — scaffold + types
  packages/db/      Drizzle schema, migrations, client
  packages/llm/     provider interface — scaffold
  eval/             scaffold
Shared tsconfig base, eslint, prettier.
Root scripts: dev, build, typecheck, test, db:generate, db:migrate,
eval, eval:seed

=== TASK 2 — DATABASE (packages/db) ===
Drizzle + Neon serverless driver.
Implement the schema in docs/DATABASE_DESIGN.md EXACTLY: merchants,
raw_events, recovery_cases, plans, actions, outcomes, audit_log,
exceptions, bandit_arms — every index and constraint listed there.
All money is bigint paise. Never floats.
Generate and run the first migration against Neon.
Seed script: one merchant, 'Demo Merchant'.

=== TASK 3 — ENV (packages/core/env) ===
Zod-validated, every variable from .env.example. Crash at startup on
missing or malformed, naming the variable. No silent defaults on anything
security-relevant.

=== TASK 4 — POLICY LOADER (packages/core/policy/load.ts) ===
Read policy.yaml, Zod-validate the whole structure, export a typed
PolicyConfig. Fail loudly on a malformed policy.

=== TASK 5 — AUTH ===
Auth.js credentials provider, one seeded user, AUTH_SECRET from env.
Protect /dashboard/*. Leave / public. No signup flow.
Print the seeded login to the console at the end of this run.

=== TASK 6 — INFRA ===
docker-compose.yml with local postgres.
GitHub Actions: typecheck + test on PR.

CONSTRAINTS
- packages/core stays PURE: no fetch, no db imports, no fs, no Date.now()
  inside decision functions. Time is a parameter.
- No business logic. No webhooks, no diagnosis, no UI beyond a bare page.

COMPLETION CRITERIA — verify each by RUNNING it
1. `git check-ignore -v .env.local` confirms it is ignored
2. `pnpm typecheck` clean
3. Migration applied to Neon — query the DB and list the tables
4. `pnpm dev` serves a page at /
5. Login works with the seeded user
6. policy.yaml loads and Zod-validates
7. Env validation crashes correctly when a variable is removed (test it)

Commit throughout, push at the end, output the PHASE COMPLETE report.
```

---

## RUN 2 — Ingest and synthetic data

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff engineer on Reflow. Phase 2 of 8.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/ARCHITECTURE.md
  docs/DATABASE_DESIGN.md
  docs/EVAL_METHODOLOGY.md
  packages/db/

OBJECTIVE
Get real and synthetic events into recovery_cases. Both lanes, one shape.

=== TASK 1 — WEBHOOK ===
apps/web/app/api/webhooks/razorpay/route.ts
- Verify HMAC SHA256 against RAZORPAY_WEBHOOK_SECRET using the
  x-razorpay-signature header. Reject 400 on mismatch.
- Insert into raw_events, idempotent on provider_event_id. A duplicate
  delivery is a no-op returning 200.
- Return 200 FAST. Never process inline — slow handlers get retried by the
  provider, and retried handlers cause duplicate work.
- Handle: payment.failed, payment.captured, order.paid, payment_link.paid,
  subscription.halted, subscription.pending, subscription.charged,
  invoice.paid, invoice.expired

=== TASK 2 — NORMALIZE (packages/core/normalize, PURE) ===
Raw payload -> RecoveryCase for all four sources:
  payment      from payment.failed
  mandate      from subscription.halted / subscription.pending
  checkout     from a simulated abandonment event
  receivable   from invoice.expired
Extract amount_paise, currency, customer_ref, method, issuer, error_code,
error_source, error_step, error_reason, external_ref.
Unknown shapes must NOT throw — return a case with nulls and let diagnosis
handle it.

=== TASK 3 — INGEST WORKER (apps/worker/ingest) ===
Poll raw_events where processed_at is null, normalize, insert
recovery_cases, stamp processed_at. Transactional.

=== TASK 4 — SYNTHETIC GENERATOR (eval/generator) ===
Follow the distribution in docs/EVAL_METHODOLOGY.md exactly:
- Source mix 55/20/15/10
- Payment cause mix as specified
- issuer_down is BURSTY: clusters of 8-20 within 30-minute windows.
  This matters — independent failures would make the naive-retry baseline
  look better than it deserves.
- insufficient_funds clusters on the 18th-28th of the month
- 12% terminal cases across all sources
- Every case: is_synthetic = true, ground_truth jsonb of
  { would_pay_eventually, responds_to[], best_window_hours,
    true_root_cause }
- Seeded PRNG. `--seed 42` reproduces the identical dataset.

=== TASK 5 — SEED SCRIPT ===
pnpm eval:seed 500 --seed 42

=== TASK 6 — TESTS ===
- Signature verification: valid, invalid, missing header
- Idempotency: same provider_event_id twice creates one case
- Normalization for all four sources, including a malformed payload
- Generator determinism: same seed, same output
- Generator distribution within tolerance

DO NOT TOUCH: diagnosis, policy, scheduler, UI

COMPLETION CRITERIA — verify each by RUNNING it
1. Craft a correctly-signed test payload, POST it locally, confirm the
   raw_events row and the recovery_case
2. POST the same payload twice — exactly one case exists
3. 500 synthetic cases in the DB with ground_truth populated
4. Distribution assertions pass — print the actual breakdown
5. Re-running with seed 42 produces byte-identical data

=== END OF RUN — HUMAN ACTION REQUIRED ===
This is the ONLY manual step in the whole build. End your report with
exactly this, filled in:

  HUMAN ACTION — register the webhook
  1. Run: ngrok http 3000
  2. Razorpay dashboard -> Settings -> Webhooks -> Add New Webhook
  3. URL:    https://<paste-ngrok-url>/api/webhooks/razorpay
  4. Secret: the value of RAZORPAY_WEBHOOK_SECRET in .env.local
  5. Tick these events:
     payment.failed, payment.captured, order.paid, payment_link.paid,
     subscription.halted, subscription.pending, subscription.charged,
     invoice.paid, invoice.expired
  6. Then create a test payment in Razorpay and confirm delivery.
  Note: the free ngrok URL changes on every restart. Re-paste when it does.

Commit, push, output the PHASE COMPLETE report.
```

---

## RUN 3 — Diagnosis

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff engineer on Reflow. Phase 3 of 8.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/POLICY_SPEC.md        <- the taxonomy lives here
  packages/core/
  packages/llm/

OBJECTIVE
Every case gets a root cause. The rule engine decides; the LLM explains and
handles the tail. Never the reverse.

=== TASK 1 — RULE ENGINE (packages/core/diagnose, PURE) ===
Deterministic table mapping (error_code, error_source, error_step, method)
-> root_cause, using the exact taxonomy in docs/POLICY_SPEC.md:
payment (8), mandate (4), checkout (3), receivable (3), terminal (3).
Full depth for payment and mandate; light for the other two.
The taxonomy is CLOSED — nothing outside it is ever a valid cause.
No match -> null, so the LLM tail takes it.

=== TASK 2 — LLM PROVIDER (packages/llm) ===
- LLMProvider interface, GroqProvider implements it.
- Model names from env: LLM_MODEL_DIAGNOSIS, LLM_MODEL_COPY,
  LLM_MODEL_GUARD. Never hardcode a model name — free catalogs change
  without notice.
- Response cache keyed by sha256(model + prompt), persisted. Cached
  responses make eval re-runs deterministic and don't burn quota.
- Rate limits: Groq free tier is 30 RPM / 8000 TPM / 200k TPD. Respect 429
  and retry-after, exponential backoff.

=== TASK 3 — INJECTION GATE, gate 0 (packages/llm/guard) ===
Screen ALL untrusted text through LLM_MODEL_GUARD before it reaches any
other model: customer_ref, error_reason, invoice notes, any merchant- or
customer-supplied string.
Above the policy.yaml threshold -> flag the case, SKIP the LLM entirely,
route to exceptions with reason 'injection_suspected'.
This is a real threat surface: that text influences money decisions.

=== TASK 4 — LLM TAIL ===
For unmapped tuples only. packages/core calls through an injected port and
stays pure.
Returns { cause, confidence, reasoning } where cause MUST be a taxonomy
member.
- Zod-validate. On failure retry ONCE with the validation error appended.
  Still failing -> 'unknown' -> exceptions.
- confidence < 0.7 -> 'unknown' -> exceptions.
- Record cause_by ('rule'|'llm') and cause_confidence on every case.
- Count and expose the parse-failure rate.

=== TASK 5 — EXPLANATION ===
Short plain-English "why this failed" per case, generated LAZILY on
dashboard view — not for the whole batch. 500 cases against an 8000 TPM
ceiling would take ~100 minutes.

=== TASK 6 — TESTS ===
- Rule table: every mapping in POLICY_SPEC has a test
- Zod rejection returns 'unknown', never throws
- Injection screening blocks a known injection string
- Cache hit avoids a second call
- Confidence threshold routes correctly

CRITICAL
The rule engine decides. The LLM explains and handles the tail. If the LLM
is resolving most cases the rule table is too thin — report the split, do
not paper over it.

COMPLETION CRITERIA — verify each by RUNNING it
1. All 500 cases diagnosed
2. Rule-vs-LLM split printed; rule share should be high
3. Unknown rate and parse-failure rate printed
4. Injection test blocks correctly
5. Re-run hits the cache and makes zero new LLM calls

Commit, push, output the PHASE COMPLETE report including the split.
```

---

## RUN 4 — Policy and guardrails

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff engineer on Reflow. Phase 4 of 8. This is the heart of the
product.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/POLICY_SPEC.md        <- intervention map and gate chain
  policy.yaml
  packages/core/diagnose/

=== TASK 1 — POLICY ENGINE (packages/core/policy, PURE) ===
root_cause + case context -> Plan {
  action_type, scheduled_for, channel, template_id,
  expected_p, est_cost_paise, policy_version, model_version
}
Implement the cause -> intervention map in docs/POLICY_SPEC.md exactly, for
all four surfaces. Costs come from policy.yaml, never hardcoded.

=== TASK 2 — TIMING STRATEGY (packages/core/timing) ===
interface TimingStrategy { schedule(cause, context, now): Date }
- StaticTimingStrategy: the delay table in POLICY_SPEC, including the
  salary-cycle heuristic (failures late in the month schedule to the 1st-3rd
  rather than +24h).
- BanditTimingStrategy: Beta-Bernoulli Thompson sampling. Bucket key
  'issuer:method:root_cause'. Arms from policy.yaml. Sample Beta(a,b) per
  arm, take the max. Cold bucket -> fall back to static.
- Selected by TIMING_STRATEGY env var, default static.
- `now` is PASSED IN. Never Date.now() inside core.
- All delays divided by DEMO_TIME_SCALE via one central helper.

=== TASK 3 — GUARDRAIL CHAIN (packages/core/guardrails, PURE) ===
Ordered, exactly as policy.yaml defines:
  0 injection_screen   1 attempt_cap        2 cooling_window
  3 contact_cap        4 quiet_hours        5 terminal_check
  6 amount_ceiling     7 compliance
Each gate returns { gate, passed, reason }. All results persist to
plans.guardrail_results.
On failure apply the gate's on_fail from policy.yaml: stop_case |
reschedule_to_boundary | downgrade_to_non_contact |
reschedule_to_window_open | escalate_human | drop_and_log
NOTHING is silently discarded — a dropped plan is persisted with reasons.
Honour kill_switch globally.

=== TASK 4 — ORDERING IS LOAD-BEARING ===
terminal_check must run before any gate that could produce contact, so a
fraud-flagged case can never be messaged. Test the ORDERING, not just the
individual gates.

=== TASK 5 — RE-ENTRANCY ===
runGuardrails(plan, state, now) must be callable twice — once at planning,
once at execution. Pure, no side effects, no cached state.

=== TASK 6 — TESTS ===
- Every gate individually, pass and fail
- Ordering: a fraud case with an otherwise-valid plan is never contacted
- Cooling window reschedules rather than dropping
- Contact cap counts ACROSS cases for one customer
- Quiet hours respects Asia/Kolkata — test 20:59 and 21:01
- Amount ceiling escalates rather than acting
- Compliance blocks mandate re-presentment without prior notice
- kill_switch halts everything
- Salary-cycle heuristic schedules into the window

COMPLETION CRITERIA — verify each by RUNNING it
1. All 500 cases produce plans
2. Gate summary printed: how many blocked by which gate
3. Terminal cases produce ZERO contact actions
4. Same input produces the same plan twice

Commit, push, output the PHASE COMPLETE report including the gate summary.
```

---

## RUN 5 — Scheduler and execution

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff engineer on Reflow. Phase 5 of 8.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/ARCHITECTURE.md
  packages/core/policy/
  packages/core/guardrails/

OBJECTIVE
Close the loop. Execute plans, observe outcomes, survive restarts.

=== TASK 1 — SCHEDULER (apps/worker/scheduler) ===
pg-boss on the same Postgres.
- Jobs persisted as rows. Never in-memory timers.
- ON BOOT: catch-up pass. Query plans where scheduled_for < now and
  status = 'pending', drain the backlog, then resume normal polling.
- The worker WILL restart. Design for it, don't hope against it.

=== TASK 2 — EXECUTION (apps/worker/execute) ===
For each due plan, in this order:
a. RE-RUN the guardrail chain against CURRENT state. A plan made at 20:00
   for 02:00 that fires at 09:30 must be re-validated. Failed -> actions
   row with status 'skipped_on_regate' and the gate that stopped it.
b. Write the actions row BEFORE the external call. If the process dies
   mid-call there is still a record — that is what stops the catch-up pass
   double-firing.
c. Execute.
d. Update the row with response and cost.
e. Record lag_seconds = executed_at - scheduled_for.

=== TASK 3 — EXECUTORS (apps/worker/executors) ===
- razorpayRetry: new order/payment attempt via test-mode API
- paymentLink: real Razorpay Payment Link
- mockOutreach: log the FULL payload (channel, template_id, rendered body,
  cost). Send NOTHING. Displayed in the dashboard.
- escalateHuman: write to exceptions
- stop: close the case
All external calls: timeout, retry with backoff, full request and response
persisted as jsonb.

=== TASK 4 — OUTCOME WATCHER (apps/worker/observe) ===
- Watch order.paid / subscription.charged / payment_link.paid
- Attribute a payment within attribution.window_hours to the action
- No outcome by deadline -> re-plan (attempt_count + 1), or stop if capped
- A payment with no preceding action -> outcome with action_id null. If we
  DID contact them, that is a FALSE NUDGE. Count it.

=== TASK 5 — AUDIT LOG (packages/db/audit) ===
- Append only. No updates, no deletes.
- hash = sha256(prev_hash + canonicalJson(payload))
- canonicalJson sorts keys — without this the same payload hashes
  differently across runs and the chain is worthless.
- Export verifyChain(caseId) and verifyChain() for the whole log.
- Log every ingest, diagnosis, plan, gate result, action, outcome.

=== TASK 6 — DEMO_TIME_SCALE ===
Every scheduling call divides its delay by DEMO_TIME_SCALE through one
central helper. No call site computes a delay independently.

=== TASK 7 — TESTS ===
- Catch-up: seed overdue jobs, boot, confirm they drain
- Re-gate: make a plan stale, confirm skipped_on_regate
- Action row written before the call (simulate a mid-call crash)
- Hash chain verifies; a tampered row fails verification
- Attribution window boundary
- False nudge detection

COMPLETION CRITERIA — verify each by RUNNING it
1. End-to-end run over 500 cases produces actions and outcomes
2. Kill the worker mid-run, restart, backlog drains, nothing double-fires
3. verifyChain() passes
4. DEMO_TIME_SCALE=360 compresses a 4h delay to 40s

Commit, push, output the PHASE COMPLETE report with a run summary:
actions by type, outcomes by result, mean lag.
```

---

## RUN 6 — Dashboard

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff frontend engineer on Reflow. Phase 6 of 8.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/UI_DESIGN_SYSTEM.md    <- follow exactly
  packages/db/

OBJECTIVE
The interface a judge clicks through. Real data, no mocks.

DESIGN — non-negotiable, from docs/UI_DESIGN_SYSTEM.md
  bg #0D0C0B  surface #171513  border rgba(242,234,217,0.08)
  text #F2EAD9  muted #8B857C  accent #C88B3E
  recovered #4A9D6E  pending #C88B3E  blocked #C4614A  stopped #6B6660
  Geist sans; Geist Mono with tabular-nums for EVERY number
  12px card radius, 8px inputs, 1px borders, NO drop shadows
  Lucide icons 1.5px stroke
  4px spacing scale, 24px card padding, 32px section gaps

BUILD IN THIS ORDER so an incomplete phase still leaves something coherent.

1. SHELL — 240px fixed sidebar, topbar, content area.
   Nav: Overview, Cases, Exceptions, Policy, Eval.
   Kill-switch status at the sidebar bottom.
   NO 'Upgrade to Pro' furniture.

2. CASE DETAIL (/dashboard/cases/[id]) — HIGHEST PRIORITY, carries the video
   Left-to-right node timeline:
     INGESTED -> DIAGNOSED -> PLANNED -> GATED -> EXECUTED -> OUTCOME
   Each node: title, one metric, timestamp. Click to expand raw payload.
   Failed gates render red with the reason inline.
   Below: full audit log, mono, with a chain-verified badge.
   FIXED horizontal flex layout with connectors. NO React Flow, no
   drag-and-drop.

3. OVERVIEW (/dashboard)
   KPI row, 5 tiles: money at risk, recovered, recovery rate, cost per
   rupee recovered, false nudges. Each: label, 32px mono value, inline SVG
   sparkline, delta. Hand-write the sparkline — do not add a chart library.
   Below, two columns: live case feed (60%), policy summary (40%).
   Full width bottom: guardrail exceptions with status pills.

4. EXCEPTIONS (/dashboard/exceptions)
   Everything the agent refused to act on, with reasons. This is the
   honesty view — give it real presence, not a footnote.

5. CASES (/dashboard/cases)
   Dense table: id (mono, truncated), source, amount, root cause, cause_by
   badge, status, attempts, age. Filters: source, root cause, status,
   synthetic/live.

6. POLICY (/dashboard/policy)
   Render policy.yaml read-only with syntax highlighting. Kill switch is
   the only interactive element, with a confirm dialog.

REQUIRED THROUGHOUT
- Loading (skeleton, never a spinner), empty (one line plus what to do
  next), and error (what failed plus retry) states on every view.
- Synthetic cases carry a visible SYNTHETIC pill. A judge must be able to
  tell the lanes apart without reading the README.
- Every number mono tabular. A KPI row that jitters on refresh looks broken.
- Server components for data fetching; client components only where
  interaction requires it.

DO NOT
- Write UI tests. Not in this budget.
- Add a chart library, animation library, or React Flow.
- Invent data. Nothing to show -> build the empty state.

COMPLETION CRITERIA — verify each by RUNNING it
1. Every view renders from real database data
2. Case timeline shows a full lifecycle including gate results
3. Loading, empty, error states everywhere
4. Responsive to 1280px minimum
5. Kill switch toggles and takes effect

Commit, push, output the PHASE COMPLETE report.
```

---

## RUN 7 — Eval harness and landing page

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan for both parts in one paragraph, then begin.

ROLE: Staff engineer on Reflow. Phase 7 of 8. Two deliverables.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/EVAL_METHODOLOGY.md    <- follow exactly
  docs/UI_DESIGN_SYSTEM.md    <- landing section
  packages/core/
  eval/generator/

=== PART A — EVAL HARNESS (do this first) ===

OBJECTIVE
Produce the numbers this entire submission rests on.

1. THREE ARMS (eval/arms) — same 500 cases, same seed, SHARED core code
   A do-nothing:  no intervention. What comes back on its own.
   B naive-retry: 3x at 24h, same method, one generic SMS each.
   C reflow:      full pipeline.
   All three call the SAME packages/core functions. If an arm needs its own
   copy of the logic the comparison is invalid — stop and report it.

2. SIMULATOR (eval/simulate) — resolves an action against ground_truth
   - action in responds_to AND within +/-30% of best_window_hours -> success
   - in responds_to but badly timed -> decayed probability
   - not in responds_to -> failure
   - would_pay_eventually true and we contacted them unnecessarily
     -> FALSE NUDGE, counted
   Deterministic given the seed.

3. METRICS per arm
   recovery rate, money recovered, messages sent, total cost,
   COST PER RUPEE RECOVERED, false nudges, wasted terminal attempts
   (must be 0 for arm C), mean time to recovery

4. DIAGNOSIS QUALITY — 100 held-out cases, never used for tuning
   precision and recall per root cause, macro-F1, unknown rate,
   rule-vs-LLM split, LLM parse-failure rate

5. GUARDRAIL BEHAVIOUR
   plans dropped/downgraded per gate, terminal cases actioned (must be 0),
   quiet-hours violations (must be 0), plans skipped on re-gate

6. OUTPUT — eval/RESULTS.md, markdown tables, regenerated by `pnpm eval`,
   never hand-edited. Header states seed, case count, date, and which lane
   produced the numbers. Include the threats-to-validity list from
   EVAL_METHODOLOGY.md.

IF ARM C DOES NOT BEAT ARM B: report it honestly in the phase report and in
RESULTS.md. Do NOT tune the simulator to produce a favourable result. A
negative result reported straight is worth more than a fabricated positive,
and the track's bar explicitly asks for honest metrics.

=== PART B — LANDING PAGE ===

apps/web/app/page.tsx. Heavy negative space, hairline 1px rules doing the
structural work INSTEAD of cards, asymmetric two-column text, small-caps
letterspaced links. Same palette as the dashboard.

1. HERO, full viewport. 72-96px headline, -0.02em, max 2 lines. Subhead in
   muted below a 1px rule. Thin-stroke SVG diagram: failure -> diagnose ->
   decide -> gate -> act -> measure. Accent at 40% opacity, 1.5px, animated
   draw-in 1.2s. Links: VIEW DASHBOARD -> and GITHUB -> in label style.
2. THE PROBLEM. One 96px mono stat left, three lines of copy right.
3. HOW IT WORKS. Four steps numbered 01-04 in mono muted, 1px rules
   between. No cards, no icons.
4. RESULTS. The table from RESULTS.md. Mono tabular, rules between rows
   only. THE MOST IMPORTANT BLOCK ON THE PAGE — give it room.
5. GUARDRAILS. Eight gates, numbered, rules between. Note they are defined
   in policy.yaml and readable in the repo.
6. FOOTER. Dashboard, GitHub, video.

Rules: max width 1200px. Accent sparingly — if amber appears more than five
times, cut some. Body copy under 65 characters per line. Mobile single
column, hero drops to 40px. Respect prefers-reduced-motion.

COMPLETION CRITERIA — verify each by RUNNING it
1. `pnpm eval` regenerates RESULTS.md end to end
2. All three arms share identical core code
3. Every metric present, including the unflattering ones
4. Landing page live, responsive, matching the design system
5. The results table on the landing page reflects RESULTS.md

Commit, push, output the PHASE COMPLETE report with the three-arm
comparison table inline.
```

---

## RUN 8 — Deploy and audit

```
AUTONOMOUS MODE. Read docs/INSTRUCTIONS.md first. Do not ask permission.
State your plan in one paragraph, then begin.

ROLE: Staff engineer + SRE on Reflow. Phase 8 of 8. Final.

FILES TO READ
  docs/INSTRUCTIONS.md
  docs/CLAUDE_CONTEXT.md
  docs/ENVIRONMENT_VARIABLES.md
  docs/TESTING_GUIDE.md
  README.md

OBJECTIVE
Live URLs, a submission-ready repo, an honest audit, and a system ready for
the human's first and only test pass.

=== TASK 1 — DEPLOY WEB (Vercel) ===
Use the Vercel CLI. Root apps/web, pnpm build.
Env vars per ENVIRONMENT_VARIABLES.md, WEB COLUMN ONLY — GROQ_API_KEY does
not belong here.
Verify the deployment, record the URL.
If the CLI needs interactive login, that is HALT reason 1 — report the
exact command for the human to run, then continue with everything else.

=== TASK 2 — DEPLOY WORKER (Railway) ===
Railway CLI. Root apps/worker. Env vars per the Railway column.
SERVERLESS TOGGLE OFF — a sleeping worker misses scheduled retries.
Set a usage alert.
Verify boot logs show the catch-up pass running.

=== TASK 3 — CONNECTIONS ===
Worker uses the Neon POOLED string with a small pool and short idle
timeout, so Neon can suspend between jobs and stay inside free-tier
compute hours.

=== TASK 4 — README FINALISE ===
- Problem, architecture diagram, stack
- Results table from RESULTS.md
- TWO-LANE DATA DISCLOSURE at the top, not a footnote
- Local run instructions, verified from a clean clone
- Live dashboard URL, repo URL, video placeholder
- Which surfaces are full-depth and which are light — state it plainly
- Anything cut from scope, stated openly

=== TASK 5 — AUDIT (report findings, fix only what is trivially safe) ===
SECURITY
- No secrets in the working tree OR in git history — scan the full history
- .env* gitignored and never committed
- Webhook signature verification active in production
- No PII anywhere
- Auth protects /dashboard/*
CORRECTNESS
- pnpm typecheck clean, all tests green
- docker compose up works from a clean clone
- pnpm eval regenerates RESULTS.md
- verifyChain() passes on production data
DATA HONESTY
- Every synthetic case flagged
- RESULTS.md states its lane
- Dashboard labels synthetic cases
DOCS
- Every doc reflects the code as built
- CLAUDE_CONTEXT.md final
- DECISIONS.md includes anything decided mid-build

=== TASK 6 — PREPARE THE HUMAN'S TEST PASS ===
Verify every step in docs/TESTING_GUIDE.md is actually executable right
now. Any step that cannot pass, fix it or record it under Known issues with
a clear explanation.
Seed a demo dataset so the dashboard is populated on first load.
Print the login credentials, both live URLs, and any deviation from the
testing guide.

=== TASK 7 — FINAL COMMIT, push, confirm repo is public ===

COMPLETION CRITERIA — verify each by RUNNING it
1. A judge can open the URL, log in, click through, see real data
2. A live Razorpay test webhook lands in production
3. Worker running, catch-up confirmed in logs
4. Every TESTING_GUIDE step executable
5. Audit report delivered with findings by severity

Output the PHASE COMPLETE report plus the audit findings, then:

  BUILD COMPLETE — READY FOR TESTING
  Dashboard: [url]
  Login:     [email] / [password]
  Repo:      [url]
  Worker:    [status]
  Known issues: [list, or none]
  Next: run docs/TESTING_GUIDE.md
```

---

## Your involvement, in full

| Moment | What | Time |
|---|---|---|
| Before Run 1 | `START_HERE.md` setup | 15 min |
| Between runs | Paste the next block into a fresh chat | 8 × 30 sec |
| After Run 2 | Register the webhook URL in Razorpay | 5 min |
| After Run 8 | `docs/TESTING_GUIDE.md` | 60 min |
| Final | Video + form | 3 hrs |

---

## Recovering a failed run

Fresh chat, paste:

```
Read docs/INSTRUCTIONS.md and docs/CLAUDE_CONTEXT.md.
The previous run for [PHASE] failed or was interrupted.
Inspect the repo, determine the actual state — do not trust the docs over
the code — and complete that phase per its block in CLAUDE_CODE_PROMPTS.md.
Then continue autonomously. Report what you found broken.
```
