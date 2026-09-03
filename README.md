# Reflow

**Razorpay Buildathon — Track 03: AI Revenue Recovery**

An agent that watches failed payments in real time, diagnoses *why* each one failed, picks the cheapest intervention likely to work, executes it inside hard guardrails, and reports measured money recovered against a baseline.

---

## Read this first — where the numbers come from

This project runs **two data lanes**. Both flow through identical decision code in `packages/core`.

| Lane | What it is | What it proves |
|---|---|---|
| **Lane 1 — Live** | Real Razorpay test-mode APIs, real webhook delivery, real HMAC signature verification, real Payment Link creation | The system works against the actual Razorpay surface |
| **Lane 2 — Synthetic** | A labelled 500-case generator with ground truth attached to every case | Honest precision, recall, and recovery-rate numbers |

**Why two lanes:** Razorpay test mode cannot produce 500 diverse failures with a known ground truth, and without ground truth there is no honest way to report precision or recovery rate. So the demo runs on real infrastructure, and the metrics run on labelled synthetic data.

Every case in the database carries an `is_synthetic` flag. Every number in `eval/RESULTS.md` states which lane produced it. Nothing in this repo blends the two.

### What the live lane does and does not cover

Being specific, because "works against real Razorpay" is easy to imply and harder to earn.

| Surface | Live Razorpay events | Notes |
|---|---|---|
| Failed one-time payments | ✅ Exercised | `payment.failed` delivered and verified end to end in production |
| Issuer downtime | ✅ Exercised | `payment.downtime.started` / `.updated` / `.resolved` |
| Recovery signals | ✅ Exercised | `payment.captured`, `order.paid`, `payment_link.paid`, `invoice.paid` |
| B2B receivables | ✅ Exercised | `invoice.expired` |
| **Mandates / subscriptions** | ❌ **Not exercised** | **Synthetic lane only — see below** |
| Checkout abandonment | ❌ Not exercised | Razorpay emits no "customer left" event; simulated by design |

**Mandates were never exercised against live Razorpay events.** The Razorpay
account used for this build does not have Subscriptions enabled, so
`subscription.halted`, `subscription.pending`, and `subscription.charged` are
unavailable to it. The mandate normalizer, the four mandate root causes, and the
mandate policy paths are all fully implemented and are exercised by the synthetic
lane — but no real mandate webhook has ever reached this system.

Read every mandate number in `eval/RESULTS.md` as synthetic. Nothing in this
repository should be taken to imply live mandate coverage.

Checkout abandonment is a different case: there is no Razorpay event for it at
all, so it is simulated deliberately rather than as a limitation. The
`checkout.abandoned` event type is ours, and it is labelled as such in
`raw_events.event_type`.

Full method: [`docs/EVAL_METHODOLOGY.md`](docs/EVAL_METHODOLOGY.md)

---

## The problem

- 10–20% of online payment attempts in India fail on the first try. Most are recoverable — bank downtime, an abandoned OTP, a temporarily low balance — not genuine refusals.
- The standard merchant response is a cron job: retry three times, 24 hours apart, same method, same message. It ignores *why* the payment failed.
- Subscriptions are worse. An e-mandate debit fails, the merchant retries blindly, the customer churns without ever being asked.
- B2B invoices go overdue and someone chases them by hand on WhatsApp.
- The merchant never sees a number for what they lost or what they got back.

**The gap: diagnosis and intervention are disconnected.** Everyone retries. Almost nobody asks what would actually work for *this specific failure*, and nobody measures whether the retry was worth its cost.

---

## What Reflow does

```
failure ──▶ diagnose ──▶ decide ──▶ guardrails ──▶ act ──▶ observe ──▶ learn
             │             │            │           │         │
          root cause    plan +      8 ordered   Razorpay   attribute
          taxonomy      timing        gates      API /     outcome to
                                                 outreach    action
```

Every money action is explainable, bounded, gated, and logged to an append-only hash-chained audit trail.

### Four recovery surfaces, one engine

| Surface | Depth | Root causes | Interventions |
|---|---|---|---|
| Failed one-time payments | **Full** | 8 | 5 |
| Mandate / subscription failures | **Full** | 4 | 3 |
| Checkout abandonment | Light | 3 | 2 |
| B2B overdue receivables | Light | 3 | 2 |

Breadth of engine over depth of all four. The two full-depth surfaces carry the headline numbers; all four are measured.

### Diagnosis: measured before inferred

The rule engine decides; the LLM explains and handles the tail. Three paths, in
strict precedence, and every case records which one answered it in `cause_by`:

| Path | `cause_by` | Confidence | When |
|---|---|---|---|
| **Razorpay downtime signal** | `downtime_signal` | 1.0 | The failure falls inside a confirmed outage window for the same issuer and rail |
| Deterministic rule table | `rule` | 1.0 | The `(error_code, error_source, error_step, method)` tuple is mapped |
| LLM tail | `llm` | model's own, ≥ 0.7 | Nothing else matched |

**Reflow uses Razorpay's `payment.downtime.*` events rather than inferring
downtime from error codes.** Razorpay reports issuer outages directly, so
`issuer_down` becomes an *observed fact* with a start and end time instead of a
guess from a `GATEWAY_ERROR`. That is a platform-native signal most retry systems
ignore, and it changes the intervention: during a confirmed outage the right move
is to wait for the window to clear, not to burn attempts against a bank that is
down.

The inference path is kept fully working and independently tested, because the
synthetic lane has no downtime events at all — so both paths must stand alone.

On the 500-case synthetic batch the rule table answers **100%** of cases at
**99.6%** accuracy against ground truth, which is the intended shape: a thin rule
table pushing work to the LLM would be a design smell, and the split is reported
either way.

---

## Results

<!-- Generated by `pnpm eval`. Do not edit by hand. -->
<!-- Populated in Chat 7. -->

_See [`eval/RESULTS.md`](eval/RESULTS.md)._

---

## Guardrails

The agent touches money, so it is bounded before it is clever. Eight ordered gates, defined in a single human-readable [`policy.yaml`](policy.yaml):

| # | Gate | Purpose |
|---|---|---|
| 0 | Injection screen | Untrusted text is screened before reaching any LLM |
| 1 | Attempt cap | Max 3 recovery attempts per case |
| 2 | Cooling window | No two actions within 4h on the same case |
| 3 | Contact cap | Max 3 messages per customer per day, across all cases |
| 4 | Quiet hours | No outreach 21:00–09:00 IST |
| 5 | Terminal check | Fraud, chargeback, opt-out, revoked mandate → hard stop |
| 6 | Amount ceiling | Above ₹25,000 the agent proposes; a human approves |
| 7 | Compliance | Mandate re-presentment requires pre-debit notice; SMS requires a DLT template ID |

Plus a global kill switch. Every gate result is persisted on the plan — nothing is silently discarded.

**Guardrails re-run at execution time, not just at planning time.** A retry scheduled for 02:00 that fires late at 09:30 is re-checked against current state before it executes.

---

## Architecture

```
Razorpay ──webhook──▶ Vercel (Next.js)          Neon Postgres
                       ├─ /api/webhooks          ├─ raw_events
                       ├─ landing page           ├─ recovery_cases
                       └─ dashboard              ├─ plans / actions / outcomes
                                                 ├─ audit_log (hash-chained)
                                                 └─ pg-boss job queue
                                                          ▲
                       Railway (worker) ──────────────────┘
                       ├─ scheduler (catch-up on boot)
                       ├─ executors (retry / link / outreach)
                       ├─ outcome watcher
                       └─ Groq LLM calls
```

`packages/core` is pure — no I/O, no fetch, no database. That is what lets the live worker and the eval harness share **identical** decision logic, which is the claim the metrics table rests on.

Detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 15 App Router, Tailwind, shadcn/ui |
| Worker | Node + TypeScript, pg-boss |
| Database | Neon Postgres, Drizzle ORM |
| LLM | Groq — GPT-OSS 120B / 20B, Llama Prompt Guard 2 |
| Payments | Razorpay test mode |
| Hosting | Vercel (web) + Railway (worker) |

Rationale for each: [`docs/DECISIONS.md`](docs/DECISIONS.md)

---

## How this was built

Specified by hand, implemented autonomously by Claude Code across eight phases, each with explicit completion criteria verified by execution. `docs/DECISIONS.md` records every architectural decision and why the alternative was rejected. `docs/CLAUDE_CONTEXT.md` is the running build log.

---

## Run it locally

```bash
pnpm install
cp .env.example .env.local     # fill in your own values
pnpm db:migrate
pnpm eval:seed 500             # generate the labelled synthetic batch
pnpm dev                       # web on :3000
pnpm --filter worker dev       # worker
pnpm eval                      # regenerate eval/RESULTS.md
```

Offline alternative:
```bash
docker compose up              # local postgres
```

---

## Non-goals

Stated plainly, because scope discipline is part of the design:

- No real customer data, ever. Synthetic only.
- No real SMS or WhatsApp is sent. Outreach payloads are logged and displayed in full, dispatched nowhere.
- No autonomous action above the amount ceiling.
- Not a fraud detector. Fraud cases are routed out, not judged.
- Not a dunning-email SaaS. The point is the diagnosis → decision loop, not message templates.

---

## Links

- **Live dashboard:** _added on deploy_
- **Pitch video:** _added on submission_
- **Track brief:** Razorpay Buildathon, Track 03
