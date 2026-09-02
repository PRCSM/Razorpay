# DECISIONS

Architecture decision records. Settled decisions — **do not relitigate** unless new information genuinely forces it.

Format: Decision · Context · Options · Chosen · Reason · Trade-offs · Consequences

---

## ADR-001 — Track 03, AI Revenue Recovery

**Context.** Five tracks. Solo builder with production payments experience (escrow, KYC, webhook hardening). Six days.

**Options.** (1) Agentic Commerce (2) Risk Manager (3) Revenue Recovery (4) Finance Controller (5) Open.

**Chosen.** Track 03.

**Reason.** Only track whose outcome is a rupee number. Directly reuses existing payments experience. Track 01 will attract the largest field and is hardest to prove value in. Track 02 needs labelled data and real ML depth. Track 04 is winnable but has a lower ceiling.

**Trade-offs.** Broader scope than Track 04. More surface to get wrong.

**Consequences.** The eval harness is not optional — the entire pitch rests on a measured number.

---

## ADR-002 — Four surfaces, two at full depth

**Context.** The track lists five recovery surfaces. ~40 usable hours.

**Options.** (a) One surface, very deep (b) Two full (c) All four full (d) All four, varying depth.

**Chosen.** (d). Payments and mandates at full policy depth; checkout abandonment and receivables light.

**Reason.** One `RecoveryCase` abstraction carries all four through the same pipeline, so breadth is cheap. Depth is the expensive part, so it's spent where the money is. "Four surfaces, one engine" is a stronger claim than four thin ones — and the bar explicitly punishes shallow work.

**Trade-offs.** Two surfaces are visibly lighter. Must be disclosed, not hidden.

**Consequences.** README states which surfaces are full-depth. Cut order under pressure: receivables → checkout → bandit → Hinglish.

---

## ADR-003 — Two-lane data strategy

**Context.** Razorpay test mode cannot produce 500 realistic failures with ground truth. Honest precision/recall requires ground truth.

**Options.** (a) Live only — no real metrics (b) Synthetic only — no real integration (c) Both, disclosed (d) Both, blended silently.

**Chosen.** (c).

**Reason.** (d) is dishonest and, if spotted, discredits every number. (a) and (b) each give up half of what the track asks for. Disclosure converts a limitation into a credibility signal.

**Trade-offs.** Requires building and documenting a generator. A judge may discount synthetic numbers — correctly.

**Consequences.** `is_synthetic` on every case. `EVAL_METHODOLOGY.md` states the split. Disclosure sits at the top of the README, not in a footnote.

---

## ADR-004 — Hosting: Vercel + Neon + one Railway worker

**Context.** Cost matters. The scheduler needs a persistent process; Vercel functions are request-scoped.

**Options.** (a) All Railway (b) Vercel + Neon + Railway worker (c) All Vercel with cron (d) Fly.io.

**Chosen.** (b).

**Reason.** All-Railway costs roughly $12–18/month across three always-on services — the $5 trial credit lasts under two weeks, and judging may run past submission. The split keeps web and database on free tiers and puts only the worker (~$3–5) on Railway, covered by trial credit. Total: ~$0–5. (c) fails because minute-granularity stateless cron cannot run a durable scheduler without reimplementing one badly.

**Trade-offs.** Two deploy pipelines, two env-var sets. One-time setup cost, not recurring.

**Consequences.** `ENVIRONMENT_VARIABLES.md` maps every variable to its home. Webhook endpoint lives on Vercel; the worker has no public inbound surface.

---

## ADR-005 — pg-boss over Redis/BullMQ

**Context.** Need delayed jobs, retries, durability. ~500 jobs, not 500k.

**Options.** (a) BullMQ + Redis (b) pg-boss on the existing Postgres (c) hand-rolled polling.

**Chosen.** (b).

**Reason.** One fewer account, one fewer service, one fewer failure mode. Jobs share a transaction boundary with the audit log. Throughput ceiling is irrelevant at this scale.

**Trade-offs.** Lower ceiling than Redis. Polling-based, so sub-second precision isn't guaranteed — irrelevant when delays are measured in hours.

**Consequences.** Job durability comes free: a scheduled job survives worker restarts because it's a database row.

---

## ADR-006 — Always-on containers, not scale-to-zero

**Context.** Railway's Serverless mode is opt-in and sleeps a service after 5–10 minutes without outbound traffic.

**Options.** (a) Serverless on, save cost (b) Always on (c) External cron ping to keep it awake.

**Chosen.** (b), plus application-layer durability.

**Reason.** A sleeping worker misses scheduled retries — that breaks the core product. (c) is a hack that costs nearly as much as staying awake. A judge hitting a cold boot is a bad first impression.

**Trade-offs.** ~$3–5/month instead of near-zero.

**Consequences.** Durability is handled in the app, not the platform: jobs in Postgres, catch-up pass on boot, guardrails re-run at execution, `lag_seconds` recorded and surfaced. The system survives downtime rather than assuming it won't happen.

---

## ADR-007 — Groq free tier, provider abstracted

**Context.** LLM needed for tail diagnosis, explanations, outreach copy. Budget ₹0.

**Options.** (a) Anthropic API (b) OpenAI (c) Groq free tier (d) local model.

**Chosen.** (c), behind an `LLMProvider` interface with model names in env vars.

**Reason.** Free with no card. GPT-OSS 120B is comfortably strong enough for constrained classification and short copy. Sub-100ms time-to-first-token makes the dashboard feel instant on video. Llama Prompt Guard 2 gives a purpose-built injection filter on the same platform.

**Trade-offs.** Open-weight models are less rigorous at strict JSON schema than frontier models — mitigated by Zod plus one retry. Free catalogs change without notice; providers have removed free models with no warning. Hinglish quality is unproven and must be tested early.

**Consequences.** Every model name is an env var. Swapping providers is config, not refactor. Responses cached by input hash — deterministic re-runs, no quota burn.

---

## ADR-008 — Prompt Guard as gate 0

**Context.** The system ingests merchant- and customer-supplied text and feeds it to a model that influences money decisions.

**Options.** (a) Trust the input (b) Regex/heuristic filtering (c) A dedicated injection classifier.

**Chosen.** (c) — Llama Prompt Guard 2, first gate in the chain.

**Reason.** A real threat surface, not a theoretical one. Free on the same platform, fast, purpose-built. Regex filtering of natural language injection doesn't work.

**Trade-offs.** One extra call per untrusted field. False positives route legitimate cases to exceptions.

**Consequences.** Runs before any other LLM call. Detection flags the case and skips the LLM entirely.

---

## ADR-009 — `packages/core` is pure

**Context.** The eval harness claims to measure the system that actually runs. That's only true if both execute the same code.

**Options.** (a) Pure core shared by both (b) Separate eval implementation (c) Eval calls the live worker.

**Chosen.** (a). No I/O, no fetch, no db, no `Date.now()` inside decision functions — time passed in.

**Reason.** (b) measures something that isn't the product. (c) is slow, non-deterministic, and untestable. Purity is what makes the metrics defensible.

**Trade-offs.** Some ceremony threading time and config through function signatures.

**Consequences.** The most important constraint in the codebase. Violating it invalidates `RESULTS.md`. Enforced in `INSTRUCTIONS.md` and in review.

---

## ADR-010 — Drizzle over Prisma

**Chosen.** Drizzle.

**Reason.** SQL-close, which matters because there are real analytical recovery queries. First-class `jsonb` — this schema stores a lot of it. No generate step slowing the Claude Code edit loop.

**Trade-offs.** Smaller ecosystem, thinner docs, more manual migration review.

**Consequences.** `packages/db` is the only place SQL lives.

---

## ADR-011 — Rule engine decides, LLM explains

**Context.** Diagnosis could be LLM-first or rules-first.

**Options.** (a) LLM classifies everything (b) Rules only (c) Rules first, LLM on the tail.

**Chosen.** (c).

**Reason.** Razorpay error codes are a finite, documented set — a lookup table handles the bulk deterministically. An LLM owning classification is non-deterministic, unauditable, quota-bound, and the first thing a judge will attack. (b) can't handle unmapped tuples.

**Trade-offs.** The rule table is manual work and needs maintenance.

**Consequences.** `cause_by` recorded per case; the rule-vs-LLM split is reported. A high LLM share is treated as a negative signal about rule coverage.

---

## ADR-012 — Bandit behind a strategy interface, static ships first

**Chosen.** `TimingStrategy` interface. `StaticTimingStrategy` default, `BanditTimingStrategy` config-selected.

**Reason.** Ships something working immediately and makes learning a clean addition rather than a rewrite. It is also the first thing cut if time runs out.

**Trade-offs.** Slight indirection before it's needed.

**Consequences.** Empty bandit table degrades to the static table. The eval can compare both strategies as a bonus finding.

---

## ADR-013 — Auth: seeded merchant, credential login, no signup

**Chosen.** Auth.js credentials provider, one seeded user, `/dashboard/*` protected, `/` public.

**Reason.** Judges need to log in and look around. They don't need an org invite flow. Roughly two hours, and an unprotected dashboard looks unfinished.

**Consequences.** `merchant_id` is on every table so multi-tenancy is modelled; RLS is not enabled. Documented as modelled-not-enforced.

---

## ADR-014 — Modular monolith, two deployables

**Chosen.** Shared core, two deployed processes, one database.

**Reason.** The split exists for exactly one reason: the scheduler needs a long-running process and Vercel functions are request-scoped. No other justification is claimed, and none is needed.

**Consequences.** No service mesh, no inter-service API, no distributed tracing. The database is the integration point.


---

## ADR-015 — Autonomous AI execution

**Context.** Six days, solo, and the human's time is better spent on the video, the form, and a single thorough test pass than on reviewing code they didn't write.

**Options.** (a) Approval gate at every phase (b) Fully autonomous, human tests at the end (c) Autonomous with self-verification and a HALT protocol.

**Chosen.** (c).

**Reason.** (a) makes the human the bottleneck and wastes their limited hours on review they aren't positioned to do well. (b) is reckless — an unverified phase silently poisons every phase after it, and nobody finds out until Day 6. (c) keeps the throughput of full autonomy while replacing human approval with machine verification: explicit completion criteria, each verified by actually running it, self-correction on failure, and a hard stop when self-correction fails twice.

**Trade-offs.** A wrong architectural interpretation in an early phase propagates further before anyone catches it. Mitigated by phase reports, `CLAUDE_CONTEXT.md`, and the human skimming three specific signals: the Day 1 distribution breakdown, the Day 2 rule-vs-LLM split, and the Day 5 arm comparison.

**Consequences.** `docs/INSTRUCTIONS.md` defines the HALT protocol and the self-verification loop. Every run block carries explicit, runnable completion criteria. `docs/TESTING_GUIDE.md` exists because the human tests exactly once.

---

## ADR-016 — Claude Code owns git

**Context.** The human asked not to manage commits. The repository must be public for submission and `.env.local` holds a live database credential with full read/write/drop.

**Options.** (a) Human commits manually (b) Claude Code commits, human pushes (c) Claude Code owns the full git lifecycle.

**Chosen.** (c), with `.gitignore` as the mandatory first commit of Run 1.

**Reason.** Splitting responsibility for git is how secrets leak — each party assumes the other checked. Full ownership makes the protection unambiguous and puts it before any code exists to accidentally reference a secret.

**Trade-offs.** Requires non-interactive push auth configured before Run 1. A push failure mid-phase is a HALT.

**Consequences.** `.gitignore` covering `.env*` is committed alone, first, verified with `git check-ignore`. Every phase-ending commit is preceded by a `git diff --cached` scan for secret-shaped strings. History is never rewritten and never force-pushed.
