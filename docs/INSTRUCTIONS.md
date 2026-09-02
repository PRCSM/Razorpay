# INSTRUCTIONS — how Claude Code operates in this repository

**Read this at the start of every session, before anything else.**

You have no memory of previous sessions. This repository's documentation is the only persistent state.

---

## Operating mode: AUTONOMOUS

You run each phase end to end without asking permission to proceed.

The human is not reviewing your work between steps. They set up credentials and will test the finished system. Between now and then, **you own the build**: writing code, running tests, fixing your own failures, updating documentation, committing, and pushing.

### What autonomy does NOT mean

- Not skipping verification. It means verifying yourself instead of asking someone else to.
- Not guessing when unsure. It means using the HALT protocol.
- Not silence. It means reporting at phase boundaries instead of at every step.
- Not claiming success you haven't verified. **An unverified completion claim is the most damaging thing you can do here** — the next phase builds on it, and the human won't catch it until the end.

### The self-verification loop

Every phase ends with explicit completion criteria. For each one:

1. Run the actual check — the command, the query, the test.
2. Passed → move on.
3. Failed → diagnose, fix, re-run.
4. Failed again after a genuine fix attempt → **HALT** and report.

Never mark a criterion passed because the code "looks right". Run it.

---

## HALT protocol

Stop and report only for these four reasons:

1. **Credential missing or rejected** — a key is absent, expired, or returns 401/403.
2. **External service blocking** — Neon, Razorpay, Groq, GitHub, or a registry is down or rate-limiting past your retries.
3. **Genuine business ambiguity** — a rule isn't in the docs and guessing could produce wrong money behaviour. Check `docs/DECISIONS.md` and `docs/POLICY_SPEC.md` before halting.
4. **Completion criteria failed twice** after a real fix attempt.

When you halt, output exactly:

```
HALT — [phase name]
Reason: [one line]
What I need: [the specific thing]
State: [what's done, what's committed, what's incomplete]
Resume: [what to paste to continue]
```

Then update `CLAUDE_CONTEXT.md`, commit what works, and stop.

**Do not halt for:** style preferences, minor library choices, whether to add a nice-to-have, formatting, naming. Decide, note it in `DECISIONS.md`, keep going.

---

## Git — you own it

Nobody is committing manually. You handle all of it.

**First commit of Run 1, before anything else:** write `.gitignore` covering `.env*`, `node_modules`, `.next`, `dist`, `.turbo` — and commit it on its own.

`.env.local` holds a live database password with full read/write/drop, and **this repository is public**. If it reaches a commit, that credential is exposed to the internet. Protect it first, then build.

Then:
- Commit at each meaningful step, not once per phase. Conventional format: `feat(core): add mandate root cause mapping`.
- Push at the end of every phase, minimum.
- Never commit secrets, real values in `.env.example`, `node_modules`, build output, or credentials in fixtures.
- Never force-push. Never rewrite history.
- Before each phase-ending commit, run `git diff --cached` and scan for anything secret-shaped.

A push failing on auth is HALT reason 1.

---

## Session start

1. Read this file.
2. Read `docs/CLAUDE_CONTEXT.md`.
3. Read the FILES TO READ in the phase block.
4. Inspect the actual repo. Docs drift; code is truth.
5. State your plan in one paragraph — for the record, not for approval.
6. **Begin immediately.**

Step 5 is a written plan, not a question. Don't wait.

---

## Hard rules

1. **Stay inside the current phase.** Something broken elsewhere goes under *Known issues* in `CLAUDE_CONTEXT.md`. Don't fix it.
2. **Never change architecture silently.** If you must deviate, do it, log it in `docs/DECISIONS.md` with the reason, and flag it in your phase report.
3. **Never invent business rules.** Not in the docs and it affects money → HALT.
4. **`packages/core` stays PURE.** No `fetch`, no db imports, no fs, no `Date.now()` inside decision functions — time is a parameter.

   This is the most important constraint in the codebase, and it isn't stylistic. The eval harness claims to measure the system that actually runs. That's only true if both execute the same code. Break purity and every number in `RESULTS.md` becomes unverifiable.
5. **Money is integer paise.** Never floats. Never a `number` that might be rupees.
6. **Nothing is silently discarded.** Dropped plans, failed gates, unparseable LLM responses — all persisted with reasons.
7. **Report incomplete work honestly.** "Items 1–4 done, item 5 stubbed because X" is useful. A false completion costs hours downstream.

---

## Code standards

**TypeScript** — `strict: true`. No `any`. No non-null `!` without a justifying comment. Zod at every boundary: env, webhooks, LLM responses, `policy.yaml`.

**Naming** — files `kebab-case.ts`, types `PascalCase`, functions `camelCase`. Database `snake_case`, plural tables. Money columns end `_paise`. Durations carry a unit.

**Errors** — domain failures return a result object; exceptions are for genuinely exceptional cases. Log with case id and phase. Never swallow an error to keep a flow moving.

**Structure** — one responsibility per file. Past ~300 lines it's probably two. `packages/core` exports pure functions; side effects live in `apps/`.

---

## Testing — you are the only tester until the end

The human tests once, at the end. Until then your tests are the only safety net, so weight them toward what would be expensive to discover late:

- Root-cause rule table — every mapping
- Guardrail chain — every gate, **plus ordering**
- Policy engine — cause → intervention, all four surfaces
- Webhook signature verification and idempotency
- Audit hash-chain integrity, including tamper detection
- Synthetic generator determinism and distribution
- Zod rejection paths on malformed LLM output
- Scheduler catch-up after restart
- Re-gating dropping a stale plan

No UI component tests. Not in this budget.

Vitest, tests beside source as `*.test.ts`. **`pnpm test` must be green before every phase-ending commit.** If you can't make it green, HALT — don't commit red and move on.

---

## Session end — every phase, no exceptions

1. `pnpm typecheck` — clean
2. `pnpm test` — green
3. Every completion criterion verified by actually running it
4. Update `docs/CLAUDE_CONTEXT.md` — every section
5. Update any doc your work made inaccurate
6. Commit and push
7. Output the phase report:

```
PHASE COMPLETE — [name]
Built: [what now exists]
Verified: [criterion → how checked → result]
Deviations: [what differed from spec, and why]
Known issues: [anything left broken]
Human action needed: [usually none]
Next: [phase name]
```

---

## Context discipline

Context is a budget. Spend it on the phase, not rediscovery.

- Read only what the phase needs.
- Don't re-read files already in context.
- Don't summarise the repo back.
- If a phase is too large to finish cleanly, complete what you can, write an honest handoff, and say a fresh chat is needed. **A clean handoff beats a degraded finish** — quality drops sharply once context saturates, and a rushed final third is how silent bugs enter.

---

## Project constants

| Thing | Value |
|---|---|
| Repo | `github.com/PRCSM/Razorpay` (public) |
| Deadline | 6 days |
| Platform | Web only. No mobile, ever. |
| Full-depth surfaces | Payments, mandates |
| Light-depth surfaces | Checkout abandonment, receivables |
| Cut order | receivables → checkout → bandit → Hinglish |
| Never cut | Eval harness, guardrail chain, audit trail, honest disclosure |

Cutting is allowed under time pressure. Cutting **quietly** is not — anything cut goes in the README and in your phase report.
