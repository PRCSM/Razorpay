# ARCHITECTURE

## Shape

A **modular monolith split across two deployables**, sharing one database and one pure core package.

Not microservices. Not a single process. The split exists for exactly one reason: the recovery scheduler needs a long-running process, and Vercel functions are request-scoped. That is the whole justification.

```
┌─────────────────────────────────────────────────────────────┐
│  Razorpay (test mode)                                        │
└────────────┬──────────────────────────────▲──────────────────┘
             │ webhooks                     │ API calls
             ▼                              │
┌──────────────────────────────┐            │
│  VERCEL — apps/web           │            │
│  ├─ /                landing │            │
│  ├─ /dashboard/*     UI      │            │
│  └─ /api/webhooks/razorpay   │            │
│       verify → store → 200   │            │
└────────────┬─────────────────┘            │
             │ write                        │
             ▼                              │
┌─────────────────────────────────────┐     │
│  NEON POSTGRES                      │     │
│  raw_events · recovery_cases        │     │
│  plans · actions · outcomes         │     │
│  audit_log · exceptions             │     │
│  bandit_arms · pgboss.job           │     │
└────────────▲─────────────────┬──────┘     │
             │ read/write      │ poll       │
             │                 ▼            │
┌────────────┴──────────────────────────────┴──┐
│  RAILWAY — apps/worker (always on)           │
│  ├─ ingest      raw_events → recovery_cases  │
│  ├─ diagnose    rules, then LLM tail         │
│  ├─ plan        policy + guardrails          │
│  ├─ schedule    pg-boss, catch-up on boot    │
│  ├─ execute     re-gate, then act            │
│  ├─ observe     attribute outcomes           │
│  └─ learn       bandit arm updates           │
└────────────┬─────────────────────────────────┘
             │
             ▼  Groq API (diagnosis tail, copy, injection screen)
```

---

## Why the webhook lives on Vercel, not the worker

- Razorpay needs a stable public HTTPS URL. Vercel gives one free, with automatic TLS.
- Receiving is trivial work: verify HMAC, insert a row, return 200. It doesn't need a persistent process.
- Keeping Razorpay pointed at Vercel means the worker has no inbound surface at all — nothing public, nothing to attack.
- The handoff is the database. The worker polls; it is never called directly.

**The endpoint never processes inline.** Verify, store, return 200 fast. Slow webhook handlers get retried by the provider, and retried handlers cause duplicate work.

---

## Package boundaries

```
apps/web        Next.js. Landing, dashboard, webhook receiver. Reads DB, writes raw_events.
apps/worker     Node. The whole recovery loop. Reads and writes everything.
packages/core   PURE. Types, diagnosis rules, policy engine, guardrail chain. No I/O.
packages/db     Drizzle schema, migrations, client factory. The only place SQL lives.
packages/llm    Groq provider behind an interface. Prompts, Zod schemas, response cache.
eval/           Synthetic generator, three comparison arms, RESULTS.md writer.
```

### The purity rule

`packages/core` has no `fetch`, no database import, no file system, no `Date.now()` inside decision functions — time is passed in as a parameter.

This is the single most important constraint in the codebase, and it is not stylistic.

The eval harness makes a claim: *these numbers describe the system that actually runs in production.* That claim is only true if the eval harness and the live worker execute **the same code**. Purity is what makes that possible — the same `diagnose()` and `plan()` and `runGuardrails()` functions, called with synthetic inputs in one case and live inputs in the other.

If core reaches out to the network or reads the clock, the two paths diverge and every number in `RESULTS.md` becomes unverifiable.

---

## Data flow, step by step

**1. Ingest**
Webhook arrives → HMAC verified against `RAZORPAY_WEBHOOK_SECRET` → row inserted into `raw_events`, idempotent on `provider_event_id` → 200 returned.
Duplicate delivery is a no-op. Razorpay retries webhooks; this is where naive implementations double-charge.

**2. Normalize**
Worker picks up unprocessed `raw_events` → builds a canonical `RecoveryCase`.
Four sources — `payment`, `mandate`, `checkout`, `receivable` — collapse into one shape. Everything downstream is source-agnostic.

**3. Diagnose**
Deterministic rule table maps `(error_code, error_source, error_step, method)` → one root cause.
Unmapped tuples go to the LLM, which returns `{cause, confidence, reasoning}` under a Zod schema. Low confidence → `unknown` → exception list, no action.
`cause_by` records `'rule'` or `'llm'` on every case, so the split is measurable.

**The rule engine decides. The LLM explains and handles the tail. Never the reverse.**

**4. Plan**
Root cause + case context → a `Plan`: action type, scheduled time, channel, template, expected recovery probability, estimated cost.
Timing comes from a swappable strategy — static table by default, Thompson-sampling bandit when enabled.

**5. Gate**
Eight ordered gates. Each returns `{passed, reason}`. All results persist to `plans.guardrail_results`.
A failed gate downgrades or drops the plan, with the reason recorded. Nothing vanishes.

**6. Execute**
pg-boss fires at the scheduled time → **guardrails re-run** → action row written *before* the external call → Razorpay API or mock outreach → response recorded.
`lag_seconds` captures the gap between scheduled and actual execution. Downtime is measured, not hidden.

**7. Observe**
Watch for `order.paid` / `subscription.charged` / link paid. A payment inside the attribution window is credited to the action.
No outcome by deadline → re-plan, or stop if caps are reached.

**8. Learn**
Closed cases write `(root_cause, issuer, method, action, hour, outcome)` to the outcomes table. Bandit arms update per `issuer × method` bucket.

---

## Resilience

The worker will restart — deploys, crashes, platform events. The design assumes it.

- **Jobs live in Postgres**, not memory. A job scheduled at 22:00 survives a 02:00 restart.
- **Catch-up pass on boot** drains overdue jobs before normal polling resumes.
- **Re-gating at execution** means a late job can't violate quiet hours just because it was planned earlier.
- **`lag_seconds` is logged and surfaced.** An audit trail showing "executed 4h late, re-validated, still compliant" is stronger than pretending downtime never happens.

---

## Security posture

| Surface | Control |
|---|---|
| Webhook | HMAC signature verification, idempotency key, fast 200 |
| LLM input | Llama Prompt Guard 2 screens all untrusted text as gate 0 |
| LLM output | Zod validation, one retry, then `unknown` — never trusted raw |
| Money actions | Amount ceiling above which a human approves |
| Audit | Append-only, hash-chained, `verifyChain()` helper |
| Secrets | Env only. Never in code, tests, fixtures, or docs. |
| PII | None. Synthetic customer references only. |
| Worker | No public inbound surface at all |

**Prompt injection is a real threat here, not a theoretical one.** The system ingests merchant- and customer-supplied text — names, notes, invoice descriptions, VPA handles — and feeds it to a model that influences money decisions. Gate 0 exists for that reason.

---

## Deliberately not built

| Not doing | Why |
|---|---|
| Microservices | Two deployables is already one more than ideal |
| Redis | pg-boss on the existing Postgres covers delayed jobs and retries |
| Kubernetes | Two containers |
| Mobile app | Out of scope, permanently |
| Multi-tenancy enforcement | `merchant_id` is on every table; RLS is not enabled. Modelled, not enforced. |
| Real outreach dispatch | Payloads logged and displayed. Nothing sent. |
| Staging environment | Six days |
