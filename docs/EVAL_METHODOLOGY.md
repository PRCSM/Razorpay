# EVAL_METHODOLOGY

How every number in this project was produced.

Judges should be able to read this and then argue with the numbers. That's the point — a metric you can't interrogate isn't evidence.

---

## The honesty problem, stated plainly

Razorpay test mode will not produce 500 diverse, realistically distributed payment failures with a known ground truth. It can't — a sandbox has no real customers who would or wouldn't have paid.

Without ground truth there is no honest way to report precision, recall, or recovery rate. You can show a demo, but you cannot show a measurement.

So this project runs two lanes, and never blends them.

| Lane | Data | Used for |
|---|---|---|
| **Live** | Real Razorpay test-mode APIs, real webhooks, real HMAC verification, real Payment Links | Proving the system works against the actual Razorpay surface |
| **Synthetic** | 500 labelled cases from a generator in `eval/generator` | Every measured number in `RESULTS.md` |

Both lanes execute **identical code** in `packages/core`. That is what makes the synthetic measurement meaningful: the functions being measured are the functions that run live.

Every case carries `is_synthetic`. Every table in `RESULTS.md` states its lane. The dashboard tags synthetic cases with a visible pill.

**If you only remember one thing: the demo is real, the metrics are synthetic, and nothing is mixed.**

---

## The synthetic generator

`eval/generator` produces N cases with ground truth attached.

### Distribution

Shaped to be plausible rather than convenient. Documented so you can disagree with it.

| Source | Share |
|---|---|
| Payments | 55% |
| Mandates | 20% |
| Checkout abandonment | 15% |
| Receivables | 10% |

Root causes within payments:

| Cause | Share | Shape |
|---|---|---|
| `insufficient_funds` | 24% | Clusters in the 18th–28th of the month |
| `otp_abandoned` | 20% | Uniform |
| `issuer_down` | 16% | **Bursty** — clusters of 8–20 in 30-minute windows |
| `gateway_timeout` | 12% | Uniform |
| `issuer_declined` | 12% | Uniform |
| `invalid_vpa` | 6% | Uniform |
| `expired_card` | 6% | Uniform |
| `merchant_config_error` | 4% | Uniform |

Terminal cases (fraud, chargeback, opt-out) are injected at **12% across all sources**.

**Why bursty issuer downtime matters:** real outages are correlated. If failures were independent, a naive retry would look better than it deserves, because it would never hit the same outage twice. Modelling the burst is what makes the baseline fair.

### Ground truth

Every synthetic case carries:

```json
{
  "would_pay_eventually": true,
  "responds_to": ["delayed_retry", "payment_link"],
  "best_window_hours": 18,
  "true_root_cause": "insufficient_funds"
}
```

- `would_pay_eventually` — would this customer have paid with no intervention at all? Drives the false-nudge metric.
- `responds_to` — which interventions work for this case. An action not on the list fails.
- `best_window_hours` — the optimal timing. Actions inside ±30% succeed at full rate; outside, at a decayed rate.
- `true_root_cause` — the diagnosis label.

### Determinism

Seeded PRNG. `pnpm eval:seed 500 --seed 42` reproduces the identical dataset. Without this, arm comparisons are noise.

### What the generator does not model

Stated because omissions matter more than inclusions:

- Real customer psychology. Response is a probability draw, not a behaviour model.
- Message content effects. A well-written nudge and a bad one perform identically here.
- Cross-case interaction beyond the daily contact cap.
- Genuine issuer-specific behaviour. Issuers are labels with distributions, not models of real banks.

**So the absolute numbers are not forecasts.** The *relative* comparison between arms is the finding, because all three arms face exactly the same dataset.

---

## The three arms

Same 500 cases, same seed, same core code.

| Arm | Behaviour |
|---|---|
| **A — Do nothing** | No intervention. Baseline: how much comes back on its own. |
| **B — Naive retry** | Retry 3× at 24h intervals, same method, one generic SMS each. The industry-standard cron. |
| **C — Reflow** | Full pipeline: diagnose → policy → guardrails → timed action → observe. |

Arm A matters more than it looks. Without it, Arm C's recovery rate is meaningless — some customers pay regardless, and claiming credit for them would be dishonest.

---

## Metrics

### Per arm

| Metric | Definition |
|---|---|
| Recovery rate | recovered cases ÷ total cases |
| Money recovered | Σ `amount_recovered_paise` |
| Messages sent | count of contact actions |
| Total cost | Σ `est_cost_paise` |
| **Cost per ₹ recovered** | total cost ÷ money recovered |
| **False nudges** | contacted cases where `would_pay_eventually = true` and no action was needed |
| Wasted terminal attempts | actions taken on terminal cases (should be **0** for Arm C) |
| Mean time to recovery | mean(`closed_at` − `opened_at`) for recovered cases |

**Cost per rupee recovered is the headline.** Recovery rate alone can be gamed by messaging everybody. This metric is what a merchant would actually optimise.

**False nudges is the honesty metric.** It is the number a team hiding something would leave out. Reporting it is cheap and buys more credibility than any other single line in the table.

### Diagnosis quality — held-out slice

100 cases held out from the 500, never used for tuning.

- Precision and recall per root cause
- Macro-F1
- `unknown` rate
- **Rule-vs-LLM split** — what fraction was resolved deterministically
- LLM parse-failure rate (Zod rejections)

A high LLM share is a **negative** signal here, and reported as such: it means the rule table is thin and the metrics rest on a less predictable component.

### Guardrail behaviour

- Plans dropped or downgraded per gate
- Terminal cases actioned — must be 0
- Quiet-hours violations — must be 0
- Plans skipped on re-gate at execution

---

## Cost model

Nothing is actually sent. These are the rates a real deployment would pay, stated so they can be challenged.

| Item | Rate |
|---|---|
| SMS | ₹0.20 |
| WhatsApp template | ₹0.80 |
| Human escalation | ₹50 |
| Retry / link / method switch | ₹0 |
| LLM | ₹0 (Groq free tier), token counts logged |

Human escalation at ₹50 is a rough staff-time estimate and the softest number in the table. It's called out here rather than buried.

---

## Running it

```bash
pnpm eval:seed 500 --seed 42
pnpm eval
```

Writes `eval/RESULTS.md`. Fully regenerable — never hand-edited.

LLM responses are cached by input hash, so re-runs are deterministic and don't re-consume Groq quota.

---

## Threats to validity

Listed because a judge will think of them, and it's better to get there first.

1. **The generator was written by the same person as the system.** Bias toward cases Reflow handles well is possible. Mitigated by fixing the distribution before implementing the policy engine, not after — but not eliminated.
2. **Absolute numbers are not real-world forecasts.** Only the relative comparison holds.
3. **The salary-cycle heuristic is unvalidated against real data.** It's a plausible assumption, measured here against a flat delay, not proven in the market.
4. **The held-out slice is 100 cases.** Small. Confidence intervals are wide and reported as such.
5. **Response probabilities are assumptions, not observations.** The generator encodes beliefs about which interventions work; if those beliefs are wrong, Arm C's advantage is overstated.
6. **Arm B may be a weak baseline.** Some merchants do better than a flat 3× cron. It's chosen as the common case, not the best case.

None of these are fixable in six days. All of them are stated.
