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
| Webhook status | **REGISTERED and enabled** in Razorpay test mode |
| Vercel env | all set except `GROQ_API_KEY` — worker-only, never add it |

The old `razorpay` Vercel project is deleted. Anything referring to it or to
`razorpay-theta-ten.vercel.app` is stale.

---

## Current phase

`RUN 3 — Diagnosis · ✅ done`

Next: **RUN 4 — Policy + guardrails** (`CLAUDE_CODE_PROMPTS.md`)

---

## Completed

**Run 1 — Foundation.** Git secured, pnpm monorepo, nine-table schema on Neon,
env and policy validation, auth, CI.

**Run 2 — Ingest.** Signed webhook receiver, pure four-source normalizer,
transactional ingest, seeded synthetic generator.

**Run 3 — Diagnosis.** Closed 21-cause taxonomy, deterministic rule table at
100% coverage and 99.6% accuracy, Razorpay downtime signal as a first-class
diagnosis path, Groq provider with a persisted cache, Prompt Guard gate 0, a
Zod-validated LLM tail, and lazy per-case explanations. All nine criteria verified
by running them.

---

## Phase status

| # | Run | Status |
|---|---|---|
| 1 | Foundation — gitignore, monorepo, schema, auth | ✅ Done |
| 2 | Ingest — webhooks, normalization, synthetic generator | ✅ Done |
| 3 | Diagnosis — rule engine, LLM tail, injection gate | ✅ Done |
| 4 | Policy + guardrails | ⬜ Not started |
| 5 | Scheduler + execution + outcomes | ⬜ Not started |
| 6 | Dashboard | ⬜ Not started |
| 7 | Eval harness + landing page | ⬜ Not started |
| 8 | Deploy + audit + test prep | ⬜ Not started |

---

## THE HEADLINE NUMBERS

```
Diagnosis split, 500 synthetic cases          Rule table vs ground truth
------------------------------------          ---------------------------
by rule            500   100.0%               coverage        500  100.0%
by downtime_signal   0     0.0%  (see below)  correct         498   99.6%
by LLM               0     0.0%               precision              99.6%
unknown              0     0.0%
parse-failure rate         0.0%
```

`downtime_signal` is 0% on the synthetic lane **by design** — the generator emits
no downtime events. That path is verified separately, end to end, against live
Razorpay-shaped payloads and persisted rows (`pnpm downtime:smoke`).

The LLM answering 0% is the intended shape, not a gap: POLICY_SPEC §6 says the
rule engine decides and the LLM handles the tail. The tail is proven working on an
unmapped tuple by `pnpm downtime:smoke` and `pnpm injection:smoke`.

### Per-cause accuracy

All 21 causes at 100% recall and 100% precision except:

| cause | truth | predicted | correct | recall | precision |
|---|---|---|---|---|---|
| `customer_opt_out` | 16 | 14 | 14 | 87.5% | 100.0% |
| `mandate_revoked` | 3 | 5 | 3 | 100.0% | 60.0% |

**The only confusion in the dataset:** 2 cases of
`customer_opt_out → mandate_revoked`. On a mandate rail these are genuinely
indistinguishable from the error fields — both present as
`(BAD_REQUEST_ERROR, customer, payment_authorization, emandate)`. **Both are
terminal**, so gate 5 stops the case either way and the money outcome is
identical. Not worth contriving a discriminator for; reported instead.

---

## Files changed this run

**New — `packages/core/src/diagnose/`** (all pure)
`taxonomy.ts` · `rules.ts` · `downtime.ts` · `port.ts` · `index.ts` ·
`rules.test.ts` · `downtime.test.ts` · `diagnose.test.ts`

**New — `packages/core/src/normalize/`**
`downtime.ts` (the `payment.downtime.*` normalizer)

**New — `packages/llm/src/`**
`cache.ts` · `groq.ts` · `guard.ts` · `diagnosis-tail.ts` · `explain.ts` ·
`llm.test.ts` (rewrote `index.ts`)

**New — `packages/db/src/schema/`**
`downtime-windows.ts` · `llm-cache.ts` · migration `0001_dry_malice.sql`

**New — `apps/worker/src/`**
`diagnose/index.ts` · `explain/index.ts` · `llm/pg-cache.ts` ·
`ingest/downtime.ts` · `scripts/diagnose.ts` · `scripts/downtime-smoke.ts` ·
`scripts/injection-smoke.ts` · `scripts/explain.ts`

**New — `eval/src/`**
`score-diagnosis.ts`

**Modified**
`packages/core/src/types/enums.ts` (`cause_by` gained `downtime_signal`) ·
`packages/core/src/index.ts` · `packages/db/src/table-names.ts` (domain vs
supporting) · `packages/db/src/scripts/verify.ts` · `apps/worker/src/ingest/index.ts`
(downtime branch) · `eval/src/generator/distribution.ts` and `index.ts` (taxonomy
correction + day counts + window clamp) · `eval/src/generator/generator.test.ts` ·
`docs/DECISIONS.md` (ADR-026…031) · `docs/DATABASE_DESIGN.md` · `README.md`

---

## Architecture changes

- **`cause_by` now has three values:** `rule`, `llm`, `downtime_signal`.
- **Diagnosis precedence is downtime → rules → LLM → unknown.** Encoded in
  `diagnoseCase`, and the order is the design.
- **Core calls the LLM through an injected port** (`DiagnosisTailPort`). Core never
  imports `@reflow/llm`; the purity fence blocks it. The worker wires the two.
- **`packages/core/src/diagnose/taxonomy.ts` is the single source of truth** for
  causes. The rule engine, the LLM prompt, the Zod schema, and the generator all
  import it, so the label sets cannot drift.

---

## Schema changes

Migration `0001_dry_malice.sql` — **additive only**, no existing table touched.

- **`downtime_windows`** — Razorpay issuer outages. UNIQUE on
  `provider_downtime_id` so `.updated`/`.resolved` upsert one row per outage.
- **`llm_cache`** — persisted LLM responses keyed `sha256(model + prompt)`.

Table count is now **9 domain + 3 supporting** (`users`, `downtime_windows`,
`llm_cache`). `pnpm --filter @reflow/db verify` labels them.

Neon state: 500 synthetic cases, all diagnosed, 0 exceptions, 0 undiagnosed.

---

## New commands

```
pnpm diagnose                 rules + downtime + LLM tail over undiagnosed cases
pnpm diagnose --rules-only    no LLM at all
pnpm diagnose --reset         clear diagnoses and exceptions, then re-diagnose
pnpm score:diagnosis          rule table vs ground_truth, per-cause accuracy
pnpm downtime:smoke           downtime + LLM tail + cache, row-level assertions
pnpm injection:smoke          gate 0 blocks a real injection payload
pnpm explain [-- <case-id>]   lazy per-case explanation, cache-first
```

---

## Decisions made this run

Six ADRs, `docs/DECISIONS.md` ADR-026…031:

- **026** the generator was corrected to the canonical taxonomy (it was emitting
  illegal labels for 45% of the dataset)
- **027** checkout carries a funnel-stage signal, not a provider error
- **028** days-overdue is carried in `error_reason`, not a new column
- **029** Razorpay downtime events as a first-class diagnosis path
- **030** explanations generated worker-side, lazily, per case
- **031** Prompt Guard is called as a text classifier, not a chat model

---

## Known issues

```
- [LOW] 2/500 cases confuse customer_opt_out with mandate_revoked. Genuinely
  indistinguishable from the error tuple on a mandate rail; both terminal, so the
  behaviour is identical — blocks next phase? NO.
- [LOW] The deleted `razorpay` Vercel project still posts a GitHub commit status,
  so commits show two checks and an aggregate failure while `reflow` is green.
- [LOW] pnpm peer-dependency warning on install — cosmetic.
- [LOW] next-auth's `jose` warns about DecompressionStream in the Edge runtime.
```

### Three real bugs found and fixed this run

1. **Prompt Guard was failing every call.** It is a text-classification model and
   rejects a system message: *"messages must contains a single user message for
   text classification models"*. Every guard call returned 400. Gate 0 still
   blocked attacks because the heuristic pre-screen runs first and fails closed —
   which is exactly why that layer exists. Caught by the cache assertion, not by a
   unit test: failed calls are not cached, so the re-run made one extra API call.
   **Watch for this pattern: a broken component hidden behind a working fallback.**

2. **`Number('')` is 0.** `scoreFromGuardOutput` parsed an empty guard response as
   0.0, i.e. "definitely benign" — failing the security screen OPEN. Now requires
   a numeric literal and returns `null` otherwise.

3. **Reasoning models return empty content on a tight token budget.** `gpt-oss-*`
   emit reasoning tokens before any content, so `max_tokens: 180` produced
   `finish_reason: "length"` with `content: ""`. Budgets are now 700.

Plus a generator bug: day-pool placement could put a case *after* the reference
date, because the first and last IST days are only partly inside a UTC window.
Now clamped. Caught by a Run 2 test, which is the argument for keeping them.

---

## Incomplete work

- **No policy engine or guardrail chain.** Every case has a cause; nothing decides
  what to do about it. `plans` is still empty. Run 4.
- **No scheduler, no execution, no outcomes.** `actions`, `outcomes`, and
  `pgboss.*` are untouched. Run 5.
- **The dashboard does not surface diagnoses.** `explainOneCase` exists and works,
  but nothing renders it — and the web app cannot generate one, since
  `GROQ_API_KEY` is worker-only (ADR-030). Run 6 must either read the cached text
  or call the worker.
- **`eval/src/index.ts` is still a placeholder.** The three arms and `RESULTS.md`
  are Run 7.
- **No held-out slice yet.** EVAL_METHODOLOGY specifies 100 of the 500 held out
  for diagnosis metrics, never used for tuning. Not implemented; the rule table was
  scored on all 500. Since the table was never tuned against the labels, this is
  reporting hygiene rather than leakage — but Run 7 should implement the split.
- **Mandates are synthetic-only.** The Razorpay account has no Subscriptions, so
  `subscription.*` events are unavailable. Disclosed in the README.
- **`DEMO_TIME_SCALE` still unconsumed.** Central scheduling helper is Run 5.

---

## Verification performed

Every line was run.

```
1. All 500 cases diagnosed
   → pnpm diagnose --reset
   → scanned 500, diagnosed 500, failed 0, undiagnosed remaining 0
   → persisted cause_by in Neon: rule 500. PASS

2. Rule / LLM / downtime split printed, rule share high
   → same run: rule 500 (100.0%), downtime_signal 0 (0.0%), llm 0 (0.0%)
   → rule share is 100%, which is the shape POLICY_SPEC §6 wants. PASS

3. Per-cause accuracy vs ground_truth printed
   → pnpm score:diagnosis
   → coverage 500/500 (100%), correct 498 (99.6%), precision 99.6%
   → per source: payment 100%, checkout 100%, receivable 100%, mandate 97.8%
   → full 21-row table printed; only confusion is 2x
     customer_opt_out -> mandate_revoked. PASS

4. Unknown rate and LLM parse-failure rate printed
   → unknown 0 (0.0%); parse-failure rate 0.0%; exceptions created 0. PASS

5. Injection test blocks correctly
   → pnpm injection:smoke  (10 checks, all PASS)
   → ZERO LLM calls for the injection case (before=0 after=0)
   → persisted root_cause = 'unknown', status = 'exception'
   → exceptions ROW in Neon reads "injection_suspected: gate 0 blocked this case
     (score 1.00 >= 0.8, by heuristic, patterns: ignore-previous-instructions,
     role-reassignment, outcome-steering, money-action-steering)"
   → the case was NOT marked recovered as the payload demanded
   → benign control DID reach the LLM (before=0 after=2) — the gate
     discriminates rather than refusing everything. PASS

6. Downtime window matching verified with a live-shaped payload
   → pnpm downtime:smoke  (16 checks, all PASS)
   → signed payment.downtime.started -> 200 -> downtime_windows ROW in Neon
     (issuer=hdfc, method=card, unresolved, severity=high)
   → INSIDE window: persisted root_cause=issuer_down,
     cause_by='downtime_signal', confidence 1.0 — even though the error tuple
     said insufficient_funds
   → OUTSIDE window: persisted insufficient_funds, cause_by='rule' — the
     inference path is intact and independent
   → unit tests cover inside/outside/wrong issuer/wrong method/unresolved. PASS

7. Re-run hits the cache and makes zero new LLM calls
   → pnpm downtime:smoke → "re-running the same tail call made ZERO new API
     calls — before=1 after=1"
   → pnpm explain → second view: cached=true newApiCalls=0, identical text. PASS

8. pnpm typecheck clean, pnpm test green
   → typecheck exit 0 across all 6 projects
   → test exit 0 — 12 files, 338 tests
   → pnpm lint exit 0. PASS

9. Push succeeded, reflow deploy still green
   → git push origin main → 45bc0e8..525e479, exit 0
   → see Git state. PASS
```

---

## Git state

```
Branch:  main
Pushed:  y
History: never rewritten, never force-pushed

Commits this run:
  2312102  feat(diagnose): closed taxonomy, rule table, downtime windows, llm_cache
  81bf916  feat(llm): groq provider, injection gate, zod-validated tail, scoring harness
  75e6b54  fix(guard): call Prompt Guard as a text classifier, add downtime smoke test
  525e479  feat(diagnose): lazy explanations, injection smoke test, ADRs and docs
  (+ this docs commit)

reflow Vercel deploy for 525e479: SUCCESS

.env.local ignored and never committed: verified — git check-ignore -v .env.local
```

---

## Human action needed

**None.** The webhook is registered and verified. Nothing is blocked.

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

**RUN 4 — Policy + guardrails.** Cause → intervention mapping from
POLICY_SPEC §3, the static timing strategy from §4, and the eight-gate chain
from §5 with ordering as a tested property.

Everything Run 4 needs is in place: every case has a `root_cause` from the closed
taxonomy, `GATE_TERMINAL_CAUSES` (4 values, including `mandate_revoked`) is
exported from core, and `policy.yaml` is loaded and validated.

**Note for gate 5:** terminal causes are already identifiable via
`isTerminalCause()`. The rule table checks them FIRST, and gate 5 must do the same
— POLICY_SPEC calls that ordering load-bearing, and it needs its own test.

---

## Running notes for future sessions

- **The taxonomy is CLOSED — 21 causes.** `packages/core/src/diagnose/taxonomy.ts`
  is the only source. Never widen it to accommodate a label from elsewhere; fix
  the other end (ADR-026).
- **Never tune the rule table against `ground_truth`.** It was written from
  POLICY_SPEC and Razorpay semantics, then scored. Fitting it to the oracle would
  make every Run 7 diagnosis number circular.
- **`packages/core` stays pure**, enforced by ESLint. `node:crypto` is fine —
  deterministic, no I/O. The LLM arrives as an injected port. Only `env/load.ts`
  and `policy/load.ts` are exempt.
- **Prompt Guard takes ONE user message, no system prompt, no fence.** Anything
  added becomes part of what is classified.
- **Gate 0 fails CLOSED on a heuristic hit and only fails open when the model is
  unreachable AND heuristics found nothing** — marked `degraded: true`.
- **Give reasoning models room.** `gpt-oss-*` spend tokens on reasoning before
  content; a tight `max_tokens` yields empty content.
- **The LLM may never choose an action.** The Zod schema is `.strict()`, so an
  `action` key is a rejected response. That is deliberate.
- **`pnpm eval:seed` deletes synthetic cases first**, scoped to
  `is_synthetic = true`. Never widen that filter.
- **The generator's draw ORDER is part of the dataset.** Adding a draw
  mid-sequence invalidates every stored fingerprint. Current: `ea588ebc96433e73`.
- **Assert against rows that reached Postgres.** Three of the four bugs this run
  were invisible to unit tests.
- **An unresolved downtime window matches every later failure forever.** Check
  `findStaleOpenWindows` before trusting a downtime attribution.
- **All money is integer paise.** A fractional amount is refused, never rounded.
- **TypeScript is pinned to 6.0.3.** 7.x breaks `typescript-eslint` and the fence.
- **Never claim a criterion passed without running it.**
