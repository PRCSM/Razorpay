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

raw_events        (standalone; consumed to create recovery_cases)
bandit_arms       (standalone; keyed by issuer × method × cause)
downtime_windows  (standalone; Razorpay issuer outages — Run 3, ADR-029)
llm_cache         (standalone; persisted LLM responses — Run 3)
users             (dashboard login — Run 1, ADR-021)
pgboss.*          (managed by pg-boss)
```

**Table count.** Nine domain tables, plus three supporting ones added later:
`users` (Run 1), `downtime_windows` and `llm_cache` (Run 3). The nine below are
the domain model; the other three are infrastructure.
`pnpm --filter @reflow/db verify` labels each table `domain` or `supporting`.

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

### `downtime_windows`
Added in Run 3. **Not one of the nine.** See ADR-029.

Issuer outages as reported by Razorpay's `payment.downtime.started` / `.updated` /
`.resolved` events.

```
id                    uuid pk
provider_downtime_id  text UNIQUE not null   -- Razorpay's downtime id; the upsert key
issuer                text null              -- bank/PSP handle, lowercase. null = platform-wide
method                text null              -- affected rail. null = all rails
started_at            timestamptz not null
resolved_at           timestamptz null       -- null = still down
severity              text null              -- low | medium | high, when supplied
status                text null              -- Razorpay's raw status string
scheduled             boolean default false  -- planned maintenance is still an outage
created_at            timestamptz default now()
updated_at            timestamptz default now()
```

Indexes: `(issuer, method)`, `(resolved_at, started_at)`

**Why this exists:** Razorpay tells us the issuer is down directly, which turns
`issuer_down` from an inference about a `GATEWAY_ERROR` into an observed fact with
a start and end time. A failure inside an active window for the same issuer and
rail is diagnosed at confidence 1.0 with `cause_by = 'downtime_signal'`.

**Why `UNIQUE` on `provider_downtime_id`:** the same reasoning as
`raw_events.provider_event_id`. One outage arrives as up to three deliveries;
without the constraint it would become three windows and the same failure would
match three ways.

⚠️ An **unresolved** window matches every later failure on that issuer
indefinitely. A missed `.resolved` delivery would therefore over-attribute
`issuer_down`. `findStaleOpenWindows` surfaces any window open beyond 24h. It is
deliberately not auto-closed — guessing an end time would fabricate data.

---

### `llm_cache`
Added in Run 3. **Not one of the nine.**

Persisted LLM responses, keyed by `sha256(model + prompt)`.

```
id                 uuid pk
cache_key          text UNIQUE not null   -- sha256(model + '\n' + prompt)
model              text not null
slot               text not null          -- diagnosis | copy | guard
response           text not null          -- raw response, before Zod validation
prompt_tokens      int null
completion_tokens  int null
latency_ms         int null
hit_count          int default 0
created_at         timestamptz default now()
last_used_at       timestamptz null
```

Index: `(model, slot)`

**Why a table and not a file:** the eval must be reproducible, so a re-run has to
make zero API calls and cannot drift. And Railway containers keep no filesystem
between deploys, so a disk cache would be cold on every restart and would burn
Groq quota re-deriving answers it already had. The free tier binds at 8,000 tokens
per minute; the cache is what makes a 500-case batch feasible at all.

The model is part of the key, so changing `LLM_MODEL_DIAGNOSIS` correctly misses
rather than silently serving an answer from a different model.

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
