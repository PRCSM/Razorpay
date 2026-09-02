# POLICY_SPEC

The decision logic. Diagnosis taxonomy, intervention mapping, guardrail chain.

Machine-readable thresholds live in `policy.yaml` at the repo root. This document explains the reasoning behind them. When they disagree, `policy.yaml` wins and this file is stale — fix it.

---

## 1. Root-cause taxonomy

Fixed and closed. The LLM may **select** from this list; it may never invent a new cause. An unmapped case becomes `unknown` and goes to the exception list.

### Payments — full depth (8)

| Cause | Meaning | Recoverable? |
|---|---|---|
| `issuer_down` | Bank or PSP unavailable | **Yes** — high |
| `issuer_declined` | Bank refused, no reason given | Maybe — low |
| `gateway_timeout` | Timed out mid-flow | **Yes** — high |
| `insufficient_funds` | Balance too low | **Yes** — timing-dependent |
| `otp_abandoned` | Customer dropped at 3DS/OTP | **Yes** — high |
| `invalid_vpa` | UPI handle wrong or inactive | Yes — needs method change |
| `expired_card` | Instrument no longer valid | Yes — needs new instrument |
| `merchant_config_error` | Our own misconfiguration | Yes — but not a customer problem |

### Mandates / subscriptions — full depth (4)

| Cause | Meaning | Recoverable? |
|---|---|---|
| `mandate_debit_failed` | Debit attempt failed, mandate intact | **Yes** |
| `mandate_insufficient_balance` | Balance short on debit date | **Yes** — timing-dependent |
| `mandate_revoked` | Customer cancelled | **No** — terminal |
| `mandate_expired` | Past validity | No — needs re-authorisation |

### Checkout abandonment — light depth (3)

`abandoned_at_method` · `abandoned_at_auth` · `price_hesitation`

### Receivables — light depth (3)

`overdue_soft` (<15 days) · `overdue_hard` (≥15 days) · `disputed_invoice`

### Terminal — all sources (3)

`fraud_flag` · `chargeback` · `customer_opt_out`

**Terminal means the agent stops. No retry, no message, no exception.** Gate 5 enforces this and it is checked before every other gate that could produce an action.

---

## 2. Interventions

| Action | What it does | Costs money? |
|---|---|---|
| `immediate_retry` | Re-attempt now | No |
| `delayed_retry` | Re-attempt at a computed time | No |
| `method_switch` | Suggest a different payment method | No |
| `payment_link` | Generate a Razorpay Payment Link | No |
| `nudge` | Outreach message | **Yes** |
| `pre_debit_notice` | Mandate pre-debit notification | **Yes** |
| `promise_to_pay` | Capture a commitment date | **Yes** |
| `escalate_human` | Queue for a person | Staff time |
| `stop` | Close the case, no further action | No |

---

## 3. Cause → intervention map

### Payments

| Cause | Plan | Reasoning |
|---|---|---|
| `issuer_down` | `delayed_retry` @ 2h, up to 3× | Downtime is usually short. Don't message — it isn't the customer's fault. |
| `issuer_declined` | `delayed_retry` @ 24h ×1, then `method_switch` | Opaque. One retry, then change something. |
| `gateway_timeout` | `immediate_retry`, then `delayed_retry` @ 1h | Often transient. Cheapest possible fix. |
| `insufficient_funds` | `delayed_retry` at the salary-cycle window + `nudge` | Timing is everything. See §4. |
| `otp_abandoned` | `immediate_retry` + `method_switch` to UPI | Customer was present and intending to pay. Highest-value recovery. |
| `invalid_vpa` | `payment_link` with alternate methods | Retrying the same handle cannot work. |
| `expired_card` | `payment_link` + `nudge` | Needs a new instrument. No retry. |
| `merchant_config_error` | `escalate_human` | Our bug. Never contact the customer about it. |

### Mandates

| Cause | Plan | Reasoning |
|---|---|---|
| `mandate_debit_failed` | `pre_debit_notice` → re-present @ 48h | Notice before re-presentment. Gate 7 enforces the ordering. |
| `mandate_insufficient_balance` | `pre_debit_notice` → re-present at the salary window | Same, timed. |
| `mandate_revoked` | `stop` | Terminal. |
| `mandate_expired` | `nudge` to re-authorise ×1 | One ask, then stop. |

### Checkout — light

| Cause | Plan |
|---|---|
| `abandoned_at_method` | `payment_link` @ 1h |
| `abandoned_at_auth` | `nudge` @ 30m + `payment_link` |
| `price_hesitation` | `stop` — pricing is not a recovery problem |

### Receivables — light

| Cause | Plan |
|---|---|
| `overdue_soft` | `nudge` @ due+3d, then `payment_link` |
| `overdue_hard` | `promise_to_pay`, then `escalate_human` |
| `disputed_invoice` | `escalate_human` immediately |

---

## 4. Timing strategy

Behind an interface. `StaticTimingStrategy` ships first; `BanditTimingStrategy` is config-selected.

### Static defaults

| Cause | Delay | Why |
|---|---|---|
| `issuer_down` | 2h | Typical downtime window |
| `gateway_timeout` | 0, then 1h | Transient |
| `otp_abandoned` | 0, then 4h | Intent is still warm |
| `insufficient_funds` | next salary window | See below |
| `issuer_declined` | 24h | No signal, so wait |
| `mandate_*` | 48h | Re-presentment convention |

**Salary-cycle heuristic:** the 1st–3rd and the last working day of the month carry materially higher balances in the Indian retail market. A failure on the 20th schedules to the 1st rather than to +24h.

This is a heuristic, labelled as one, and the eval measures whether it beats a flat delay. If it doesn't, that's a finding worth reporting.

### Bandit

Beta-Bernoulli Thompson sampling. Bucket key `issuer:method:root_cause`. Arms: `2h`, `6h`, `18h`, `48h`.

Sample `Beta(alpha, beta)` per arm, take the max. Success → `alpha += 1`. Failure → `beta += 1`. Cold buckets fall back to the static table.

Deliberately simple — roughly 60 lines. A more sophisticated model cannot be validated inside a six-day dataset, and unvalidated sophistication is worse than a documented heuristic.

---

## 5. Guardrail chain

Ordered. Every gate returns `{gate, passed, reason}`. All results persist to `plans.guardrail_results`.

A failed gate **downgrades or drops** the plan. Nothing is silently discarded.

| # | Gate | Rule | On failure |
|---|---|---|---|
| 0 | `injection_screen` | Untrusted text screened by Prompt Guard before any LLM call | Flag case → exception, skip LLM |
| 1 | `attempt_cap` | ≤ 3 attempts per case | Drop → `stop` |
| 2 | `cooling_window` | ≥ 4h since last action on this case | Reschedule to the boundary |
| 3 | `contact_cap` | ≤ 3 messages per customer per day, all cases | Downgrade to a non-contact action |
| 4 | `quiet_hours` | No outreach 21:00–09:00 IST | Reschedule to 09:00 |
| 5 | `terminal_check` | Cause not in the terminal list | Drop → `stop` |
| 6 | `amount_ceiling` | ≤ ₹25,000 for autonomous action | Downgrade → `escalate_human` |
| 7 | `compliance` | Mandate needs prior notice; SMS needs a DLT template id | Drop, log the violation |

Plus `kill_switch` in `policy.yaml` — halts all execution globally.

### Two properties that matter

**Ordering is load-bearing.** Gate 5 runs before gates that could produce contact, so a fraud-flagged case can never be messaged regardless of what came earlier. Test the ordering, not just the gates.

**Re-gating at execution.** The chain runs twice: when the plan is created, and again the moment before it executes. A plan made at 20:00 for 02:00 that actually fires at 09:30 after a restart must be re-validated. Skipped plans record `status = 'skipped_on_regate'` with the gate that stopped them.

---

## 6. What the LLM may and may not do

**May:**
- Select a root cause from the fixed taxonomy for tuples the rule table doesn't cover
- Write the human-readable "why this failed" explanation
- Draft outreach copy in English and Hinglish, filling registered templates

**May not:**
- Invent a root cause outside the taxonomy
- Choose an intervention — that is the policy engine's job
- Set a schedule
- Override any gate
- See unscreened untrusted text

Every response is Zod-validated. On failure: retry once with the validation error appended, then `unknown` → exception. The parse-failure rate is reported in `RESULTS.md`.

**The rule engine decides. The LLM explains and handles the tail.**

---

## 7. Costs

Used for `est_cost_paise` and for cost-per-rupee-recovered. Nothing is actually sent; these are the rates a real deployment would pay.

| Action | Assumed cost |
|---|---|
| Retry / method switch / payment link | ₹0 |
| SMS | ₹0.20 |
| WhatsApp template | ₹0.80 |
| Human escalation | ₹50 (staff time) |
| LLM call | ₹0 (Groq free tier), tokens logged |

Stated openly in `RESULTS.md`. A cost model you can see is a cost model a judge can argue with — which is the point.
