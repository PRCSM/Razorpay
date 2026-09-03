# CLAUDE_CONTEXT

**The living state of this project.** Rewritten at the end of every run.
This is how a session with no memory picks up where the last one stopped.

Operating mode is **AUTONOMOUS** — see `docs/INSTRUCTIONS.md`. The human is not
reviewing between phases, so this file is also their only status window. Keep it
honest and keep it current.

---

## Deployment facts — corrected in Run 2

The Run 1 report blamed a repository defect for the failing deploy. That was
wrong, and the correction matters:

| | Value |
|---|---|
| Vercel project | **`reflow`** |
| Production URL | **https://reflow-puce.vercel.app** |
| Deploy status | **GREEN** |
| Webhook target | **https://reflow-puce.vercel.app/api/webhooks/razorpay** |
| Vercel env | all set except `GROQ_API_KEY` (worker-only by design) |

An earlier Vercel project named `razorpay` was misconfigured. It is deleted, and
it is the sole reason Run 1's deployments failed — the repo built fine all along.

**One loose end:** the dead `razorpay` project's GitHub integration still posts a
commit status, so `gh api .../status` reports an aggregate `failure` even though
`reflow` reports `success`. Two checks appear per commit. Harmless, but it makes
the commit look red. See **Human action needed**.

Anything referring to `razorpay-theta-ten.vercel.app` or a `razorpay` Vercel
project is stale.

---

## Current phase

`RUN 2 — Ingest · ✅ done`

Next: **RUN 3 — Diagnosis** (`CLAUDE_CODE_PROMPTS.md`)

---

## Completed

**Run 1 — Foundation.** Git secured, pnpm monorepo, nine-table schema on Neon,
env and policy validation, auth with a seeded user, CI, local Postgres.

**Run 2 — Ingest.** Signed webhook receiver, pure four-source normalizer,
transactional ingest worker, and a seeded synthetic generator producing 500
labelled cases in Neon. All eight completion criteria verified by running them.

---

## Phase status

| # | Run | Status |
|---|---|---|
| 1 | Foundation — gitignore, monorepo, schema, auth | ✅ Done |
| 2 | Ingest — webhooks, normalization, synthetic generator | ✅ Done |
| 3 | Diagnosis — rule engine, LLM tail, injection gate | ⬜ Not started |
| 4 | Policy + guardrails | ⬜ Not started |
| 5 | Scheduler + execution + outcomes | ⬜ Not started |
| 6 | Dashboard | ⬜ Not started |
| 7 | Eval harness + landing page | ⬜ Not started |
| 8 | Deploy + audit + test prep | ⬜ Not started |

⬜ not started · 🟡 in progress · ✅ done · ⚠️ done with known gaps · 🛑 halted

---

## Files changed this run

**New — `packages/core` (pure)**
`src/webhook/signature.ts` · `src/webhook/envelope.ts` · `src/webhook/events.ts` ·
`src/webhook/index.ts` · `src/webhook/signature.test.ts` ·
`src/webhook/envelope.test.ts` · `src/normalize/index.ts` · `src/normalize/read.ts` ·
`src/normalize/normalize.test.ts`

**New — `apps/web`**
`src/app/api/webhooks/razorpay/route.ts`

**New — `apps/worker`**
`src/ingest/index.ts` · `src/scripts/webhook-smoke.ts`

**New — `eval`**
`src/generator/index.ts` · `src/generator/prng.ts` ·
`src/generator/distribution.ts` · `src/generator/time.ts` ·
`src/generator/generator.test.ts` · `src/fingerprint.ts`

**Modified**
`packages/core/src/index.ts` (barrel) · `apps/worker/src/index.ts` (ingest loop,
`--once`) · `eval/src/seed.ts` (rewritten) · `package.json` and
`apps/worker/package.json` and `eval/package.json` (scripts) ·
`docs/ENVIRONMENT_VARIABLES.md` (corrected URL) · `docs/CLAUDE_CONTEXT.md`

---

## Architecture changes

None to the shape in `docs/ARCHITECTURE.md`. The data flow now exists for steps
1–2 (ingest, normalize).

Two things a future session needs to know:

- **`raw_events.payload` stores the COMPLETE envelope**, not the inner
  `payload` object. `normalizeEvent` accepts either — it unwraps a nested
  `payload` key if present. This bit once already; see **Known issues**.
- **Signature verification and normalization live in `packages/core`**, not in the
  route. `node:crypto` is a deterministic computation, not I/O, so it does not
  breach the purity fence. The route handler is a thin shell: verify, insert, 200.

---

## Schema changes

**None.** Run 2 writes to the existing `raw_events` and `recovery_cases` tables
and added no columns. The migration is still `0000_nifty_arclight.sql`.

Current Neon state: 500 synthetic cases, all with `ground_truth`, 0 pending
`raw_events`.

---

## API changes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/webhooks/razorpay` | HMAC | **NEW.** Verify → insert → 200. Never processes inline. |
| `GET /api/webhooks/razorpay` | — | **NEW.** 405, for humans checking the URL. |
| `GET /` | public | unchanged, static |
| `GET /login` | public | unchanged |
| `GET /dashboard` | protected | unchanged |
| `/api/auth/*` | public | unchanged |

**Webhook contract**

- Header `x-razorpay-signature`: HMAC-SHA256 hex over the **raw body bytes**.
  Missing, malformed, or mismatched → **400**, nothing stored.
- Header `x-razorpay-event-id`: the idempotency key. Absent → a deterministic
  `derived_<sha256 prefix>` of the body is used instead.
- Duplicate delivery → **200** `{"received":true,"duplicate":true}`, no new row.
- Storage failure → **500** deliberately, so Razorpay retries. Never 200 on a
  failed write.

**Events.** Nine subscribed. Five open cases (`payment.failed`,
`subscription.halted`, `subscription.pending`, `invoice.expired`, plus the
simulated `checkout.abandoned`). Five are recovery signals
(`payment.captured`, `order.paid`, `payment_link.paid`, `subscription.charged`,
`invoice.paid`) — stored and stamped processed, attributed to actions in Run 5.

---

## New commands

```
pnpm ingest              drain raw_events once and exit (worker --once)
pnpm dev:worker          poll raw_events every 5s
pnpm webhook:smoke       end-to-end webhook test; BASE_URL=… to target prod
pnpm eval:seed 500 --seed 42        generate + insert synthetic cases
pnpm eval:seed 500 --seed 42 --dry-run   print the distribution, write nothing
pnpm eval:fingerprint    sha256 of the synthetic lane as stored in Neon
```

`pnpm eval:seed` **deletes existing synthetic cases first**, scoped to
`is_synthetic = true`. Live cases are never touched. That is what makes re-running
the same seed converge instead of accumulate.

---

## Decisions made this run

- **Signature + normalization in core, not the route.** Deterministic crypto is
  not I/O. Makes the trust boundary unit-testable and keeps the route thin.
- **`checkout.abandoned` is our own event type.** Razorpay emits no "customer
  left" event. Naming it explicitly keeps the simulated lane visible in
  `raw_events.event_type`.
- **Unreadable amount → 0 paise plus a warning, not a rejected delivery.**
  `amount_paise` is NOT NULL. A zero-amount case is visibly wrong and reaches the
  exception list; dropping the event would hide it.
- **A fractional amount is refused, not rounded.** A fractional "paise" value
  means the field is really rupees. Rounding would silently corrupt money.
- **Contact identifiers are hashed, never stored.** `cust_<16 hex>` from
  sha256 when only an email or phone is available, so the cross-case contact cap
  can recognise a repeat customer while the system still holds no PII.
- **`insufficient_funds` clusters at 70%, not 100%, in the salary window.**
  Forcing 100% would make the salary-cycle heuristic trivially perfect and
  overstate Arm C — exactly threat 3 in `EVAL_METHODOLOGY.md`. The window is ~37%
  of the month, so 70% is a strong, visible cluster with a real tail to get wrong.
- **Bursts share one issuer.** A real outage hits one bank, and sharing the issuer
  is what makes the correlation visible to the bandit's issuer × method bucket.
- **A fixed reference date (`2026-03-01T00:00:00Z`)** anchors the simulation
  window. Using the wall clock would silently break "same seed, same data"
  tomorrow. Override with `--reference-date`.

---

## Known issues

```
- [LOW] The deleted `razorpay` Vercel project still posts a GitHub commit status,
  so commits show two checks and an aggregate `failure` while `reflow` is green
  — GitHub/Vercel integration — blocks next phase? NO.
- [LOW] Generator source mix lands at 56.8/19.2/12.4/11.6 against a 55/20/15/10
  target; checkout is ~2.6pp low. Binomial noise at n=500 (σ≈1.6pp), inside the
  ±4pp test tolerance. Not a defect; noted so nobody "fixes" it into a bias.
- [LOW] pnpm peer-dependency warning on install — cosmetic, unchanged from Run 1.
- [LOW] next-auth's `jose` warns about DecompressionStream in the Edge runtime
  during build — transitive dependency, build succeeds.
```

### Bug found and fixed this run, worth remembering

The normalizer originally read entities from the inner `payload` object, but
`raw_events.payload` stores the **whole envelope**. Every unit test passed while
every live event silently produced a null-filled case with no `external_ref`.

It was caught only by the end-to-end smoke test, which asserted the resulting
`recovery_case` rather than the normalizer's return value. `normalizeEvent` now
accepts either shape, and `normalize.test.ts` has a
"full webhook envelope (the real ingest shape)" block so it cannot regress.

**Lesson for later runs: a unit test that feeds a hand-made fixture proves less
than one assertion against a row that actually reached Postgres.**

---

## Incomplete work

- **No diagnosis.** `recovery_cases.root_cause`, `cause_confidence`, and
  `cause_by` are still null on every live case. Run 3.
- **`packages/llm` is still interface-only.** No Groq client, no prompts, no
  injection screen, no cache. Run 3.
- **`eval/src/index.ts` is still a placeholder.** The generator and seeding are
  real; the three arms and `RESULTS.md` are Run 7.
- **Checkout abandonment has no producer.** The normalizer, event type, and
  synthetic path all exist, but nothing emits `checkout.abandoned` against the
  live lane. Synthetic cases cover it.
- **Recovery-signal events are stored, not attributed.** They get stamped
  processed with no case; matching them to actions inside
  `attribution.window_hours` is Run 5.
- **Ingest has no `merchant_id` routing.** Every case is attributed to the single
  seeded merchant, resolved by earliest `created_at`. Multi-tenancy stays modelled
  but not enforced.
- **`DEMO_TIME_SCALE` still unconsumed.** Central scheduling helper is Run 5.
- **No `pgboss.*` tables.** Run 5.

---

## Verification performed

Every line was run. Commands and results, not inspection.

```
1. Correctly-signed POST → raw_events row AND recovery_case
   → pnpm dev; pnpm webhook:smoke
   → 200 {"received":true,"duplicate":false}; 1 raw_events row;
     1 recovery_case: source=payment, amount_paise=250000, method=card,
     issuer=hdfc, error_reason=insufficient_funds, status=open,
     is_synthetic=false; raw event stamped processed_at. PASS

2. Same payload twice → exactly one case
   → second POST returned 200 {"received":true,"duplicate":true}
   → raw_events rows=1, recovery_cases=1. PASS

3. Incorrectly-signed payload rejected 400
   → bad signature → 400; missing header → 400
   → both stored nothing (raw_events rows=0). PASS

4. 500 synthetic cases in Neon with ground_truth
   → pnpm eval:seed 500 --seed 42
   → "inserted 500 synthetic case(s)"
   → pnpm eval:fingerprint → 500 synthetic, 500 with ground_truth. PASS

5. Distribution assertions pass, breakdown printed
   → pnpm eval:seed 500 --seed 42 --dry-run  (full output in the phase report)
   → sources 56.8/19.2/12.4/11.6 vs 55/20/15/10
   → terminal 12.2% vs 12%
   → payment causes (n=260): 22.7/23.8/14.6/11.5/13.1/5.8/3.5/5.0
     vs 24/20/16/12/12/6/6/4
   → issuer_down: 4 bursts, sizes [16,15,11,11], each one bank, 30-min windows
   → insufficient_funds 71/100 in the 18th-28th IST window
   → 500/500 complete ground_truth; 264 unique customers
   → 48 generator tests assert all of this. PASS

6. Re-running seed 42 produces identical data
   → pnpm eval:fingerprint  → d48a1dbb…e735d5
   → pnpm eval:seed 500 --seed 42  (cleared 500, inserted 500)
   → pnpm eval:fingerprint  → d48a1dbb…e735d5  IDENTICAL. PASS
   → in-memory fingerprint 357500545008297e stable across runs.

7. pnpm typecheck clean, pnpm test green
   → typecheck exit 0 across all 6 projects
   → test exit 0 — 8 files, 190 tests passed. PASS

8. Push succeeded, Vercel deploy green
   → git push origin main → f801935..0cc5dde, exit 0
   → reflow project: "Deployment has completed" (SUCCESS)
   → GET https://reflow-puce.vercel.app/ → 200, contains "Reflow"
   → BASE_URL=https://reflow-puce.vercel.app pnpm webhook:smoke
     → ALL 20 CHECKS PASSED against the real production webhook. PASS
   → the dead `razorpay` project also reports a failure status; see Known issues.

Also run:
   pnpm lint         → exit 0 (purity fence intact)
   pnpm build        → exit 0, /api/webhooks/razorpay registered dynamic
   pnpm ingest       → 0 pending, clean drain
```

---

## Git state

```
Last commit: 0cc5dde  fix(normalize): read entities from the stored envelope, add smoke test
Branch:      main
Pushed:      y  (origin/main == 0cc5dde)
History:     never rewritten, never force-pushed

Commits this run:
  a89e519  docs: correct Vercel project to reflow and record the permanent webhook URL
  60da581  feat(ingest): signed webhook receiver, pure normalizer, transactional ingest
  b174968  feat(eval): seeded synthetic generator with bursty outages and ground truth
  0cc5dde  fix(normalize): read entities from the stored envelope, add smoke test
  (+ this docs commit)

.env.local ignored and never committed:  verified — git check-ignore -v .env.local
                                         → .gitignore:7:.env*
```

---

## Human action needed

**1 — Register the webhook. This is the only manual step in the whole build.**
See the block at the end of the Run 2 phase report. The endpoint is already
deployed and has been smoke-tested in production, so registration is the last
piece.

Use the **existing** `RAZORPAY_WEBHOOK_SECRET` from `.env.local`. It was generated
in Run 1 and is already in Vercel. Generating a new one breaks every signature
check.

**2 — Optional, cosmetic.** Remove the deleted `razorpay` project's GitHub
integration so commits stop showing a red check. GitHub repo → Settings →
Integrations, or delete the stale project in the Vercel dashboard.

**3 — Before Run 8:** `GROQ_API_KEY` goes on Railway, not Vercel. The worker is
the only surface that calls an LLM.

**After Run 8:** run `docs/TESTING_GUIDE.md`.

---

## Dashboard login

```
URL       /login   (prod: https://reflow-puce.vercel.app/login)
email     demo@reflow.dev
password  reflow-demo-2026
```

Public in this repository by design — synthetic data only, no PII. Override with
`$env:SEED_USER_PASSWORD = '…'` then `pnpm db:seed`.

---

## Next phase

**RUN 3 — Diagnosis.** Deterministic rule table mapping
`(error_code, error_source, error_step, method)` → one root cause; the LLM tail
for unmapped tuples under a Zod schema; Llama Prompt Guard as gate 0 on all
untrusted text; `cause_by` recording `'rule'` or `'llm'` on every case.

The generator already emits realistic error tuples for every non-checkout cause
(`CAUSE_ERROR_SIGNATURES` in `eval/src/generator/distribution.ts`), and
`ground_truth.true_root_cause` is the label to score against. **Build the rule
table against that table, and measure precision on the held-out slice.**

---

## Running notes for future sessions

Traps a fresh session would otherwise hit the hard way:

- **`raw_events.payload` is the whole envelope.** Entities are at
  `payload.<entity>.entity`. `normalizeEvent` unwraps either shape — do not
  "simplify" that away.
- **HMAC is computed over the raw body bytes.** Never `JSON.parse` then
  re-serialise before verifying; key order and whitespace change the digest.
- **The webhook must never process inline.** Verify, insert, 200. A slow handler
  gets retried and retries cause duplicate work.
- **Return 500, not 200, when the insert fails.** A 200 tells Razorpay the event
  was accepted and it will never resend.
- **`pnpm eval:seed` deletes synthetic cases first.** Scoped to
  `is_synthetic = true`. Never widen that filter.
- **The generator's draw ORDER is part of the dataset.** Reordering random draws
  changes output at the same seed. Adding a draw mid-sequence invalidates every
  stored fingerprint.
- **Never call `Math.random()` or read the clock in `eval/`.** Determinism fails
  silently and nothing tells you.
- **`packages/core` must stay pure**, enforced by ESLint. Time is a parameter.
  `node:crypto` is permitted — deterministic, no I/O. Only `env/load.ts` and
  `policy/load.ts` are exempt; do not add a third.
- **All money is integer paise.** A fractional amount is refused, never rounded.
- **Do not write `.js` in relative imports** inside workspace packages (ADR-022).
- **TypeScript is pinned to 6.0.3** (ADR-024). 7.x breaks `typescript-eslint` and
  with it the purity fence.
- **`.env.local` is at the repo ROOT** and Next looks in `apps/web`; handled in
  `next.config.ts`. `POLICY_PATH` is resolved by walking up from `cwd`.
- **Neon needs the pooled connection string.** Enforced for `neon.tech` hosts only.
- **Groq free tier binds on TPM (8,000/min).** Hitting limits during eval means the
  rule table is too thin — a design smell, not a quota problem. Cache by input hash.
- **Guardrails re-run at execution time**, not only at planning.
- **Assert against rows that reached Postgres, not just function returns.** The one
  real bug in Run 2 passed every unit test and was caught only end to end.
- **Never claim a completion criterion passed without running it.** The human tests
  once, at the end.
