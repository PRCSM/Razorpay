# DATABASE_DESIGN

Neon Postgres · Drizzle ORM · one database shared by web and worker.

## Conventions

- `snake_case` tables and columns, plural table names
- UUID primary keys, generated in the database
- All timestamps `timestamptz`, stored UTC, rendered IST
- **All money is `bigint` paise.** Never a float, never rupees. Column names end `_paise`.
- Durations carry their unit: `_hours`, `_seconds`
- Provider payloads stored raw as `jsonb` — never discard what the provider sent

---

## Entity relationships

```
merchants
    └─< recovery_cases
            ├─< plans ─< actions ─< outcomes
            ├─< exceptions
            └─< audit_log

raw_events      (standalone; consumed to create recovery_cases)
bandit_arms     (standalone; keyed by issuer × method × cause)
pgboss.*        (managed by pg-boss)
```

---

## Tables

### `merchants`
Multi-tenancy is **modelled but not enforced** — `merchant_id` sits on every table so the shape is right, but no RLS. One seeded merchant for the demo. Retrofitting a tenant column later is painful; adding RLS later is easy.

```
id           uuid pk
name         text not null
created_at   timestamptz default now()
```

---

### `raw_events`
Every webhook exactly as received. Never mutated.

```
id                   uuid pk
provider_event_id    text UNIQUE not null   -- idempotency key
event_type           text not null
payload              jsonb not null
received_at          timestamptz default now()
processed_at         timestamptz null       -- null = worker hasn't consumed it
```

**Why `UNIQUE` matters:** Razorpay retries webhook delivery. Without this constraint, one retried `payment.failed` becomes two recovery cases and the customer gets contacted twice. This single constraint is the difference between a correct system and an embarrassing one.

`processed_at` is the worker's queue pointer — no separate queue table needed for ingestion.

---

### `recovery_cases`
The central entity. One row per unit of revenue at risk, regardless of source.

```
id                uuid pk
merchant_id       uuid fk → merchants
source            text     -- 'payment' | 'mandate' | 'checkout' | 'receivable'
external_ref      text     -- Razorpay payment/subscription/invoice id
amount_paise      bigint not null
currency          text default 'INR'
customer_ref      text     -- opaque. never a real name, email, or phone.
method            text     -- 'card' | 'upi' | 'netbanking' | 'wallet' | 'emandate'
issuer            text     -- bank or PSP handle
error_code        text
error_source      text
error_step        text
error_reason      text
root_cause        text null
cause_confidence  real null
cause_by          text null    -- 'rule' | 'llm'
status            text         -- open|diagnosed|planned|acting|recovered|stopped|exception
attempt_count     int default 0
opened_at         timestamptz default now()
closed_at         timestamptz null
is_synthetic      boolean default false
ground_truth      jsonb null
```

Indexes: `(merchant_id, status)`, `(root_cause)`, `(is_synthetic)`, `(source, status)`

**`is_synthetic` and `ground_truth` are the honesty columns.** They let one database hold both data lanes without ever blending them. Every query in the eval harness filters on `is_synthetic = true`; the dashboard shows both but labels them.

`ground_truth` shape (synthetic only):
```json
{
  "would_pay_eventually": true,
  "responds_to": ["delayed_retry", "payment_link"],
  "best_window_hours": 18,
  "true_root_cause": "insufficient_funds"
}
```

**`cause_by` makes the LLM's role auditable.** If most cases are resolved by `'llm'`, the rule table is too thin and the metrics are less defensible. This column is reported in `RESULTS.md`.

---

### `plans`
The agent's intent, before it acts. A plan is a decision record, not a queue entry.

```
id                 uuid pk
case_id            uuid fk → recovery_cases
action_type        text      -- immediate_retry | delayed_retry | method_switch |
                             -- payment_link | nudge | pre_debit_notice |
                             -- promise_to_pay | escalate_human | stop
scheduled_for      timestamptz
channel            text null   -- 'sms' | 'whatsapp' | 'email' | 'none'
template_id        text null   -- DLT template. required for sms.
expected_p         real        -- expected recovery probability, 0..1
est_cost_paise     bigint
policy_version     text        -- from policy.yaml
model_version      text        -- LLM model used, if any
guardrail_results  jsonb       -- [{gate, passed, reason}]
status             text        -- pending | executed | dropped | downgraded
created_at         timestamptz default now()
```

Index: `(scheduled_for, status)` — the scheduler's hot path.

**Plans are kept even when dropped.** A dropped plan with its gate reasons is evidence the guardrails work. Deleting them would erase the most interesting data in the system.

`policy_version` + `model_version` on every plan makes any decision reproducible months later.

---

### `actions`
What actually happened, externally.

```
id             uuid pk
plan_id        uuid fk → plans
case_id        uuid fk → recovery_cases
executed_at    timestamptz
lag_seconds    int          -- executed_at - scheduled_for
request        jsonb        -- exact payload sent
response       jsonb        -- exact response received
cost_paise     bigint
status         text         -- success | failed | skipped_on_regate
created_at     timestamptz default now()
```

**The row is written *before* the external call**, then updated with the response. If the process dies mid-call, there is still a record that the call was attempted — which is what lets the catch-up pass avoid double-firing.

`lag_seconds` is the downtime-honesty metric. `status = 'skipped_on_regate'` records a plan that was dropped at execution time because state had changed.

---

### `outcomes`
Did it work.

```
id                      uuid pk
case_id                 uuid fk → recovery_cases
action_id               uuid fk → actions   null   -- null = recovered with no action
result                  text  -- recovered | no_response | opted_out | failed
amount_recovered_paise  bigint default 0
observed_at             timestamptz
```

`action_id` nullable is deliberate: some customers pay on their own. Those are **false nudges** if we messaged them — counted and reported, not hidden.

---

### `audit_log`
Append-only, hash-chained.

```
id           uuid pk
case_id      uuid fk → recovery_cases  null
actor        text        -- 'system' | 'llm' | 'human' | 'scheduler'
event_type   text
payload      jsonb
prev_hash    text null
hash         text        -- sha256(prev_hash + canonical_json(payload))
at           timestamptz default now()
```

`hash = sha256(prev_hash || canonicalJson(payload))`. Canonical JSON means sorted keys — otherwise the same payload hashes differently across runs and the chain is worthless.

Ships with `verifyChain()`. Tamper-evidence, and full replay of any case.

No updates, no deletes. Enforced by convention in the repo layer; a DB trigger would be nice and isn't worth the time.

---

### `exceptions`
Everything the agent refused to handle.

```
id            uuid pk
case_id       uuid fk → recovery_cases
reason        text
needs_human   boolean default true
resolved_at   timestamptz null
```

The track brief asks for an honest exception list. This table is that list, and it gets its own dashboard view. A system that admits what it couldn't resolve is more credible than one claiming complete coverage.

---

### `bandit_arms`
Thompson sampling state for retry timing.

```
id           uuid pk
bucket_key   text     -- 'hdfc:card:insufficient_funds'
arm          text     -- '2h' | '6h' | '18h' | '48h'
alpha        real default 1
beta         real default 1
updated_at   timestamptz default now()
UNIQUE (bucket_key, arm)
```

Beta-Bernoulli conjugate: `alpha` counts successes, `beta` failures, both starting at 1 for a uniform prior. Sample from `Beta(alpha, beta)` per arm, pick the highest.

Empty table → static timing table. The system degrades to sensible defaults rather than to nothing.

---

## Migrations

Drizzle Kit. `pnpm db:generate` → review the SQL → `pnpm db:migrate`.

Never edit an applied migration; add a new one. Neon branching gives a throwaway database per eval run — reset and re-run the 500-case batch cleanly without touching main.

## Connections

Web uses Neon's serverless HTTP driver. Worker uses a **pooled** connection string with a small pool and short idle timeout, so Neon can auto-suspend between scheduled jobs and stay inside free-tier compute hours.

## Retention and backup

Six-day project. Neon's automatic point-in-time recovery is sufficient. No retention policy — synthetic data only, nothing to expire, nothing to be right-to-erasure'd.
