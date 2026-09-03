# CLAUDE_CONTEXT

**The living state of this project.** Rewritten at the end of every run.
This is how a session with no memory picks up where the last one stopped.

Operating mode is **AUTONOMOUS** — see `docs/INSTRUCTIONS.md`. The human is not
reviewing between phases, so this file is also their only status window. Keep it
honest and keep it current.

---

## Deployment facts

| | Value |
|---|---|
| Vercel project | **`reflow`** |
| Production URL | **https://reflow-puce.vercel.app** |
| Webhook target | **https://reflow-puce.vercel.app/api/webhooks/razorpay** |
| Webhook status | **REGISTERED and enabled**, 10 events, verified in production |
| Vercel env | all set except `GROQ_API_KEY` — worker-only, never add it |

The old `razorpay` Vercel project is deleted. Anything referring to it or to
`razorpay-theta-ten.vercel.app` is stale.

---

## Current phase

`RUN 4 — Policy and guardrails · ✅ done`

Next: **RUN 5 — Scheduler + execution + outcomes** (`CLAUDE_CODE_PROMPTS.md`)

---

## Completed

**Run 1 — Foundation.** Git secured, monorepo, nine-table schema on Neon, env and
policy validation, auth, CI.

**Run 2 — Ingest.** Signed webhook receiver, pure four-source normalizer,
transactional ingest, seeded synthetic generator.

**Run 3 — Diagnosis.** Closed 21-cause taxonomy, rule table at 100% coverage and
99.6% accuracy, Razorpay downtime signal, Groq provider with a persisted cache,
Prompt Guard gate 0, Zod-validated LLM tail, lazy explanations.

**Run 4 — Policy and guardrails.** Cause → intervention map for all 21 causes,
static and bandit timing strategies, downtime-aware scheduling, and the eight-gate
chain with every gate failing closed. 500 plans written, terminal contact = 0.

---

## Phase status

| # | Run | Status |
|---|---|---|
| 1 | Foundation | ✅ Done |
| 2 | Ingest | ✅ Done |
| 3 | Diagnosis | ✅ Done |
| 4 | Policy + guardrails | ✅ Done |
| 5 | Scheduler + execution + outcomes | ⬜ Not started |
| 6 | Dashboard | ⬜ Not started |
| 7 | Eval harness + landing page | ⬜ Not started |
| 8 | Deploy + audit + test prep | ⬜ Not started |

---

## THE GATE SUMMARY — 500 cases

```
scanned 500 · plans written 500 · no plan 0 · failed 0

disposition        allow 332 · rescheduled 70 · escalated 22 · dropped 19 · stopped 57
                   downgraded 0  (see Known issues — needs executed actions)

gate                evaluated  passed  failed  fail-closed
  injection_screen        500     500       0            0
  attempt_cap             500     500       0            0
  cooling_window          500     500       0            0
  contact_cap             500     500       0            0
  quiet_hours             500     394     106            0
  terminal_check          500     443      57            0
  amount_ceiling          500     473      27            0
  compliance              500     471      29            0

outcome decided by  quiet_hours 70 · terminal_check 57 · amount_ceiling 22 · compliance 19

final actions       delayed_retry 133 · stop 91 · immediate_retry 85 · pre_debit_notice 64
                    payment_link 45 · escalate_human 39 · nudge 35 · promise_to_pay 8

timing basis        static_table 215 · immediate 179 · salary_window 106

THE INVARIANT       terminal cases 57 · contact plans 107 · contact on TERMINAL 0
```

**Read the `decided by` row against the `failed` column.** `terminal_check` failed
57 times and decided all 57 — it out-ranked 36 quiet-hours failures and 5
amount-ceiling failures on those same cases. That is ADR-032's severity resolution
working: a terminal case cannot be turned back into an action by any other gate.

Every one of the 500 plans persists all eight verdicts, passes included. 76 dropped
plans are retained with their reasons — nothing is silently discarded.

---

## Files changed this run

**New — `packages/core/src/timing/`** (all pure)
`clock.ts` (the ONE delay-scaling helper + IST helpers) · `strategy.ts` ·
`static-strategy.ts` · `bandit-strategy.ts` · `index.ts` · `timing.test.ts`

**New — `packages/core/src/policy/`**
`interventions.ts` (the 21-cause map) · `engine.ts` · `engine.test.ts`

**New — `packages/core/src/guardrails/`** (all pure)
`types.ts` · `gates.ts` · `chain.ts` · `index.ts` · `gates.test.ts` · `chain.test.ts`

**New — `apps/worker/src/`**
`plan/index.ts` · `scripts/plan.ts` · `scripts/plan-smoke.ts`

**Modified**
`packages/core/src/types/enums.ts` (`TimingStrategy` → `TimingStrategyName`, to free
the name for the interface) · `packages/core/src/index.ts` ·
`packages/core/src/policy/index.ts` · `package.json` and
`apps/worker/package.json` (scripts) · `docs/DECISIONS.md` (ADR-032…036)

---

## Architecture changes

None to the shape. Four things a future session must know:

- **Gates are evaluated in order 0→7, but the disposition is resolved by
  SEVERITY** (ADR-032). `stop_case` wins absolutely. This is what makes "a terminal
  case is never contacted" a guarantee rather than a consequence of gate numbering.
- **Every gate fails closed** (ADR-033), and a fail-closed block carries
  `failedClosed: true` so it is distinguishable from an ordinary policy refusal.
  The two mean different things to an operator: one is a decision, one is a data
  problem.
- **`scaleDelayMs` / `scheduleAfter` are the only places a delay is scaled or a
  future instant produced** (ADR-034). Do not compute a delay at a call site.
- **`runGuardrails(plan, state, policy, now)` is pure and re-entrant** (TASK 7).
  Run 5 calls it a second time immediately before execution, and it may legitimately
  reach a different verdict because the state moved on. That is the feature.

---

## Schema changes

**None.** Run 4 writes to the existing `plans` and `exceptions` tables and added no
columns. Migration is still `0001_dry_malice.sql`.

Neon state: 500 synthetic cases, all diagnosed, 500 plans (402 pending, 76 dropped,
22 downgraded), 76 guardrail exceptions.

---

## New commands

```
pnpm plan               plan every diagnosed case without a pending plan
pnpm plan --reset       clear plans and guardrail exceptions, re-plan
pnpm plan:smoke         row-level proof: gates, invariant, downtime, determinism
```

---

## Decisions made this run

Five ADRs, `docs/DECISIONS.md` ADR-032…036:

- **032** gates evaluated in order, disposition resolved by severity
- **033** every gate fails closed, and the block is distinguishable
- **034** all delays pass through one scaling helper
- **035** an open outage produces a re-check, not a retry
- **036** terminal causes produce a `stop` plan, not the absence of a plan

---

## Known issues

```
- [MEDIUM] contact_cap has never fired against real data: 0 failures in 500 cases.
  It counts EXECUTED contact actions, and nothing has executed yet — `actions` is
  empty until Run 5. The gate is correct and unit-tested (including the cross-case
  property), but it is unproven end to end — blocks next phase? NO, but Run 5 must
  re-verify it once actions exist.
- [LOW] cooling_window is in the same position: 0 failures, because it reads
  `actions.executed_at`. Unit-tested, not yet exercised on real rows.
- [LOW] The deleted `razorpay` Vercel project still posts a GitHub commit status,
  so commits show two checks and an aggregate failure while `reflow` is green.
- [LOW] 2/500 cases confuse customer_opt_out with mandate_revoked (Run 3).
  Both terminal, so the outcome is identical. Asserted harmless in chain.test.ts.
- [LOW] pnpm peer-dependency warning on install — cosmetic.
```

### One real bug found and fixed this run

**Terminal causes produced no plan at all.** `maxAttempts: 0` on the `STOP`
intervention made `interventionForAttempt` return null, so `buildPlan` refused with
`ladder_exhausted` and no row was written. Three tests caught it immediately — a
missing plan row is indistinguishable from a case the planner never reached, which
is the exact ambiguity `plans` exists to remove. Fixed to `maxAttempts: 1`
(ADR-036): `stop` is a decision that must be recorded.

Worth noting what did NOT happen this run: no bug escaped to the row-level stage.
The unit tests caught the only defect, which is the first time in four runs.

---

## Incomplete work

- **No scheduler and no execution.** `plans` has 402 pending rows and nothing fires
  them. `actions` and `outcomes` are empty, `pgboss.*` does not exist. Run 5.
- **`DEMO_TIME_SCALE` is threaded but never exercised at 360×.** The helper and its
  tests exist; no real run has used a compressed scale. Run 5's scheduler is the
  first consumer that will matter.
- **The bandit is implemented but cold.** `bandit_arms` is empty, so
  `TIMING_STRATEGY=bandit` falls back to static on every case, exactly as designed.
  Arms only populate once outcomes exist. Run 5.
- **`pre_debit_notice` ordering is enforced but untested end to end.** Gate 7 blocks
  a re-presentment without prior notice, and the mandate ladder leads with the
  notice — but no notice has actually been *sent*, so the second rung has never
  been reached with a satisfied lead time on real data. Run 5.
- **The dashboard shows none of this.** 500 plans, 76 dropped with reasons, and the
  full gate record are in Neon and invisible. Run 6.
- **`eval/src/index.ts` is still a placeholder.** Three arms and `RESULTS.md` are
  Run 7.
- **No held-out slice** (carried from Run 3). EVAL_METHODOLOGY specifies 100 of the
  500 held out for diagnosis metrics. Run 7.
- **Mandates are synthetic-only.** The Razorpay account has no Subscriptions.
  Disclosed in the README.

---

## Verification performed

Every line was run.

```
1. All 500 cases produce plans; zero causes unhandled
   → pnpm plan --reset
   → scanned 500, plans written 500, no plan 0, failed 0
   → engine.test.ts loops all 21 taxonomy causes and asserts each yields a plan
   → cases still without a plan: 0. PASS

2. Gate summary printed
   → same run; full table above. All 8 gates evaluated 500× each.
   → pnpm plan:smoke → "every persisted plan has all 8 gate verdicts — 500/500"
   → gate failures queried from the persisted JSON:
     quiet_hours 106 · terminal_check 57 · compliance 29 · amount_ceiling 27. PASS

3. Terminal cases produce ZERO contact actions — asserted on DB rows
   → pnpm plan:smoke
   → "ZERO executable contact plans on terminal cases — 0 violation(s)"
   → terminal-case plan action types in Neon: stop 57 (nothing else)
   → "every terminal case is closed as stopped — 57/57"
   → chain.test.ts asserts the property for all four terminal causes, including
     when all seven other gates PASS, and when an earlier gate would have merely
     downgraded. PASS

4. Every gate blocks on empty/null/undefined/NaN
   → pnpm vitest run packages/core/src/guardrails
   → 44 dedicated hostile-input assertions across all 8 gates, plus malformed
     policy thresholds. 107 tests passed.
   → pnpm plan:smoke → a real case with missing data: "BLOCKED, not allowed",
     "the block is marked as fail-closed", "still records all 8 verdicts". PASS

5. Same input produces the same plan twice
   → pnpm plan:smoke
   → "the same input produces an identical plan twice — delayed_retry @
     2026-03-01T05:30:00.000Z"  (a 20 Feb failure scheduled into the salary window)
   → "the guardrail chain is deterministic and re-entrant — allow twice". PASS

6. Downtime-aware scheduling verified against a real downtime_windows row
   → pnpm plan:smoke inserts a real row, reads it back, and plans against it
   → RESOLVED: "scheduled relative to the REAL resolved_at, not a static +2h",
     basis downtime_resolved
   → OPEN: "an OPEN outage yields a re-check, not a money action"
     (recheckOnly=true, basis downtime_recheck, cost 0, contacts nobody). PASS

7. pnpm typecheck clean, lint clean, pnpm test green
   → typecheck exit 0 across all 6 projects
   → lint exit 0
   → test exit 0 — 16 files, 523 tests. PASS

8. Push succeeded, deploy still green
   → see Git state. PASS
```

---

## Git state

```
Branch:  main
Pushed:  y
History: never rewritten, never force-pushed

Commits this run:
  (see git log 40032f4..HEAD)
  feat(policy): intervention map, timing strategies, fail-closed guardrail chain
  feat(plan): worker plan stage, gate summary CLI, row-level smoke test
  docs: Run 4 phase report, five ADRs

.env.local ignored and never committed: verified — git check-ignore -v .env.local
```

---

## Human action needed

**None.** Nothing is blocked.

Optional, cosmetic: remove the deleted `razorpay` project's GitHub integration so
commits stop showing a red check.

**Before Run 8:** `GROQ_API_KEY` goes on Railway, not Vercel.

**After Run 8:** run `docs/TESTING_GUIDE.md`.

---

## Dashboard login

```
URL       /login   (prod: https://reflow-puce.vercel.app/login)
email     demo@reflow.dev
password  reflow-demo-2026
```

---

## Next phase

**RUN 5 — Scheduler + execution + outcomes.** pg-boss on the existing Postgres,
catch-up on boot, re-gating at execution, the action row written BEFORE the external
call, `lag_seconds`, outcome attribution inside the 72h window, and bandit arm
updates.

Everything Run 5 needs is in place:

- **402 pending plans** with `scheduled_for` set and every gate verdict recorded.
- **`runGuardrails` is re-entrant** — call it again immediately before execution.
  A plan that no longer passes gets `actions.status = 'skipped_on_regate'`, and
  `chain.decidedBy` names the gate that stopped it.
- **`scaleDelayMs`** is the only place `DEMO_TIME_SCALE` is applied. The scheduler
  must use `scheduleAfter`, not its own arithmetic.
- **`banditBucketKey(issuer, method, rootCause)`** and `armToHours` are exported;
  an outcome updates `alpha` on success and `beta` on failure.
- **Two gates are unproven against real data** — `contact_cap` and
  `cooling_window` both read `actions`, which is empty. Re-verify them once
  actions exist; that is the highest-value check in Run 5.

---

## Running notes for future sessions

- **`packages/core` stays pure**, enforced by ESLint. `now` is a parameter; the RNG
  is injected. Only `env/load.ts` and `policy/load.ts` are exempt.
- **Never compute a delay at a call site.** `scaleDelayMs` / `scheduleAfter` only.
- **Every gate fails closed.** If you add a gate, add its hostile-input test in the
  same commit. `Number('')` is `0` — that is how Run 3's security bug happened.
- **`stop_case` wins absolutely.** Do not make the chain short-circuit; the full
  eight-verdict record is required, and severity resolution is what protects the
  terminal invariant.
- **The LLM may never choose an action.** The policy engine decides; the diagnosis
  Zod schema is `.strict()` so an `action` key is a rejected response.
- **The taxonomy is CLOSED — 21 causes.** `buildPlan` refuses anything outside it.
- **Costs come from policy.yaml.** A malformed cost falls back to the EXPENSIVE
  figure, never 0.
- **All money is integer paise.** Gate 6 rejects a non-integer amount outright.
- **Assert against rows that reached Postgres.** Runs 2 and 3 each shipped a bug
  that passed every unit test.
- **`pnpm eval:seed` deletes synthetic cases first**, scoped to
  `is_synthetic = true`. Never widen that filter. Fingerprint: `ea588ebc96433e73`.
- **TypeScript is pinned to 6.0.3.** 7.x breaks `typescript-eslint` and the fence.
- **Never claim a criterion passed without running it.**
