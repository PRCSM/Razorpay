# CLAUDE_CONTEXT

**The living state of this project.** Rewritten at the end of every run.
This is how a session with no memory picks up where the last one stopped.

Operating mode is **AUTONOMOUS** — see `docs/INSTRUCTIONS.md`. The human is not
reviewing between phases, so this file is also their only status window. Keep it
honest and keep it current.

---

## Current phase

`RUN 0 — not started`

Next: **RUN 1 — Foundation** (`CLAUDE_CODE_PROMPTS.md`)

---

## Completed

_Nothing yet. Documentation only._

---

## Phase status

| # | Run | Status |
|---|---|---|
| 1 | Foundation — gitignore, monorepo, schema, auth | ⬜ Not started |
| 2 | Ingest — webhooks, normalization, synthetic generator | ⬜ Not started |
| 3 | Diagnosis — rule engine, LLM tail, injection gate | ⬜ Not started |
| 4 | Policy + guardrails | ⬜ Not started |
| 5 | Scheduler + execution + outcomes | ⬜ Not started |
| 6 | Dashboard | ⬜ Not started |
| 7 | Eval harness + landing page | ⬜ Not started |
| 8 | Deploy + audit + test prep | ⬜ Not started |

⬜ not started · 🟡 in progress · ✅ done · ⚠️ done with known gaps · 🛑 halted

---

## Files changed this run

_None._

---

## Architecture changes

_None. Baseline in `docs/ARCHITECTURE.md`; 16 decisions in `docs/DECISIONS.md`._

---

## Schema changes

_None. Baseline in `docs/DATABASE_DESIGN.md`._

---

## API changes

_None._

---

## Decisions made this run

_None yet. Anything decided mid-build goes here AND in `DECISIONS.md`._

---

## Known issues

_None yet._

```
- [severity] description — where — blocks next phase? y/n
```

---

## Incomplete work

_None yet._

Be specific. "Bandit stubbed, interface defined, static strategy active" is useful.
"Some stuff left" is not. The human will not read the code — this is what they see.

---

## Verification performed

_None yet._

Record what you actually **ran**, not what exists. In autonomous mode this is the
only evidence a phase really passed.

```
- criterion → command run → result
```

---

## Git state

_No commits yet._

```
Last commit:
Pushed:      y/n
.env.local ignored and never committed:  verify with git check-ignore -v
```

---

## Human action needed

**Before Run 1:** complete `START_HERE.md` — fill the two blank secrets in
`.env.local`, confirm `git push` works without an interactive prompt.

**After Run 2:** register the webhook URL in Razorpay. Run 2's report gives the
exact URL and event list. This is the only manual step in the whole build.

**After Run 8:** run `docs/TESTING_GUIDE.md`.

---

## Next phase

**RUN 1 — Foundation.**

---

## Running notes for future sessions

Traps a fresh session would otherwise hit the hard way:

- **`.gitignore` covering `.env*` is the first commit of Run 1, before any code.**
  `.env.local` holds a live Neon password with full read/write/drop and the repo is
  public.
- **`packages/core` must stay pure.** No I/O, no `Date.now()` inside decision
  functions — pass time in. The eval harness and the live worker share this code;
  if it isn't pure, every number in `RESULTS.md` is unverifiable.
- **All money is integer paise.** A float in a money column is a bug.
- **Neon needs the pooled connection string** for the worker. The direct endpoint
  exhausts connections on a long-running process. Region is ap-southeast-1.
- **Groq free tier binds on TPM (8,000/min), not RPD.** Hitting limits during eval
  means the rule table is too thin — that's a design smell, not a quota problem.
  Cache LLM responses by input hash.
- **Guardrails re-run at execution time**, not only at planning. A plan made at
  20:00 for 02:00 that fires at 09:30 must be re-checked.
- **`DEMO_TIME_SCALE`** compresses all scheduling delays for the video. One central
  helper; no call site computes a delay independently. Retrofitting means touching
  every call site.
- **Never claim a completion criterion passed without running it.** The human tests
  once, at the end. A false pass here surfaces on Day 6 with no time to fix it.
