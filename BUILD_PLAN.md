# BUILD_PLAN

6 days. Claude Code does the development. You set up, paste eight blocks, register one webhook, and test at the end.

**Day 5 evening is the real deadline.** Day 6 is video, form, and things breaking.

---

## Timeline

| Day | Runs | Your involvement |
|---|---|---|
| **0** | Setup + Run 1 | 15 min setup, then paste Run 1 |
| **1** | Run 2 | Paste Run 2. **Register the webhook** (5 min). |
| **2** | Runs 3–4 | Paste twice |
| **3** | Run 5 | Paste once |
| **4** | Run 6 | Paste once |
| **5** | Run 7 | Paste once. Rough-cut the video in the evening. |
| **6** | Run 8 | Paste once. **Test (60 min)**, video, form. |

Total hands-on time before testing: roughly 25 minutes spread over five days.

---

## Day 0 — Setup and foundation

**You (15 min):** `START_HERE.md`. Files in place, `.env.local` complete, tooling installed, `git push` working without a prompt.

**Run 1 (~2h unattended):** `.gitignore` first, monorepo, Drizzle schema migrated to Neon, env validation, policy loader, Auth.js, Docker, CI.

**Check the report for:**
- `git check-ignore -v .env.local` confirmed
- All nine tables in Neon
- Login credentials printed

⚠️ If Run 1 halts on git auth, fix the credential helper and re-paste. Don't let it sit overnight — the schedule has no slack.

---

## Day 1 — Ingest

**Run 2 (~3h):** webhook endpoint with HMAC and idempotency, normalization for all four sources, synthetic generator, seed script.

**You (5 min), when the report arrives:** the report ends with exact webhook registration instructions. Start ngrok, paste the URL into Razorpay, tick the nine events, fire a test payment.

**Check the report for:**
- The distribution breakdown. Look at it. Bursty issuer downtime, insufficient funds clustered late-month, ~12% terminal.
- Same seed reproduces identical data.

This is the one place where a quiet mistake poisons everything downstream — every number in the project rests on this dataset.

---

## Day 2 — The brain

**Run 3 (~3h):** rule table, Groq provider, Prompt Guard gate 0, LLM tail with Zod, response cache.

**Check for:** the rule-vs-LLM split. **Rule share should be high.** If the LLM is resolving most cases, the rule table is thin and the metrics are less defensible — send it back to expand coverage.

**Run 4 (~3h):** policy engine, timing strategies, eight-gate chain.

**Check for:** gate summary, and zero contact actions on terminal cases.

Densest day. If only Run 3 lands, do Run 4 first thing on Day 3 and compress Run 5.

---

## Day 3 — The loop

**Run 5 (~4h):** pg-boss scheduler, catch-up on boot, executors, re-gating at execution, outcome attribution, hash-chained audit, `DEMO_TIME_SCALE`.

**Check for:** the restart test actually ran and nothing double-fired.

**Decision point, end of day.** Behind schedule? Cut receivables now, not on Day 5.

---

## Day 4 — Dashboard

**Run 6 (~4h):** built in priority order — case timeline first, then overview, exceptions, cases table, policy view.

**Check for:** the case detail timeline. It carries your video. If it's weak, that's worth a follow-up run on its own.

---

## Day 5 — Numbers and landing

**Run 7 (~4h):** three arms, all metrics, `RESULTS.md`, landing page.

**Check for:**
- Arm C beats Arm B on cost per rupee recovered
- False nudges reported, not hidden
- Zero terminal actions in Arm C

⚠️ **If Arm C doesn't win, do not let it be fudged.** Investigate and report what you found. A negative result honestly reported beats a fabricated positive — and the track's bar explicitly asks for honest metrics.

**You, evening (1h):** rough-cut the video. Unpolished, but recorded. This is the single most commonly skipped step and the most commonly regretted.

---

## Day 6 — Ship

**Run 8 (~2h):** deploy both, repoint the webhook, audit, prepare the test pass.

**You (60 min):** `docs/TESTING_GUIDE.md`, top to bottom. Collect failures into one list, hand it to a fresh chat.

**You (2h):** polish the video. Set `DEMO_TIME_SCALE=360` first.

| Time | Beat |
|---|---|
| 0:00–0:30 | The problem, in one number |
| 0:30–1:30 | Live: trigger a failure, watch it diagnose and plan |
| 1:30–2:30 | Guardrails: fraud case refused, contact cap downgrade, `policy.yaml` |
| 2:30–3:30 | The eval table, including the honest costs |
| 3:30–4:15 | Audit trail: replay one recovered case |
| 4:15–5:00 | What broke and how you got out |

**You (1h):** the form. Question 12 is the one they read first.

---

## Cut order

Claude Code cuts in this order under time pressure, and **states it in the README and in its phase report**:

1. **B2B receivables** — least judge value per hour
2. **Checkout abandonment** — leaves two full-depth surfaces
3. **Bandit** — the static timing table is defensible on its own
4. **Hinglish copy** — English only
5. **Policy dashboard view** — `policy.yaml` is readable in the repo

**Never cut:** the eval harness, the guardrail chain, the audit trail, honest disclosure.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Video left to the last night | **High** | Rough cut Day 5, no exceptions |
| A run halts overnight and you don't notice | **High** | Check the report before you sleep |
| Day 2 overruns | Medium | Push Run 4 to Day 3, compress Run 5 |
| Generator distribution is subtly wrong | Medium | Actually read the Day 1 breakdown |
| Rule table too thin, LLM doing the work | Medium | Check the Day 2 split |
| ngrok URL changes, webhooks silently fail | Medium | Re-paste after every restart |
| Groq rate limits during eval | Medium | Cache is built in; hitting limits means the rule table is thin |
| Arm C underperforms | Low | Report honestly |

---

## What "done" looks like

- Public repo, no secrets in history
- Live dashboard a judge can log into
- `pnpm eval` regenerates an honest results table
- Guardrails demonstrably block things, visibly, with reasons
- Audit chain verifies
- README discloses the two lanes, the depth split, and anything cut
- A five-minute video that ends on a real debugging story
