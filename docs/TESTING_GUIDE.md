# TESTING_GUIDE

Your one test pass, after Run 8. Budget 60 minutes.

You haven't looked at the code. That's fine — this guide tests the system as a judge would, plus the few things only you can check.

Work top to bottom. Mark each ✅ or ❌. Anything ❌ goes into a single fix list at the end, then hand that list to a fresh Claude Code chat.

---

## Part 1 — Security (10 min) — do this first

If anything here fails, stop and fix before touching the rest.

```bash
git log --all --oneline | wc -l              # sanity: commits exist
git check-ignore -v .env.local               # must print a .gitignore rule
git log --all -p -- .env.local | head        # must print NOTHING
```

- [ ] `.env.local` is ignored and has never been committed
- [ ] `git log --all -p | grep -iE "npg_|rzp_test_|gsk_"` returns nothing
- [ ] Repo is public on GitHub
- [ ] `.env.example` has keys but no values

**If a secret is in history**, it's exposed — rotate that credential in Neon/Razorpay/Groq before submitting. Deleting the file in a later commit does not remove it from history.

---

## Part 2 — Local build (10 min)

Clone fresh, as a judge would:

```bash
cd /tmp && git clone https://github.com/PRCSM/Razorpay reflow-test
cd reflow-test && pnpm install
cp /path/to/your/.env.local .            # judges use their own
pnpm typecheck
pnpm test
pnpm db:migrate
pnpm eval:seed 500 --seed 42
pnpm dev
```

- [ ] `pnpm install` succeeds from clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` — all green, and there are a real number of tests, not three
- [ ] `pnpm dev` serves on :3000
- [ ] README instructions match what you actually had to do

---

## Part 3 — Landing page (5 min)

Open `http://localhost:3000`.

- [ ] Loads without console errors
- [ ] Hero headline is large, warm-black background, cream text
- [ ] Flow diagram renders and animates once
- [ ] Results table is populated with real numbers
- [ ] All eight guardrails listed
- [ ] Dashboard and GitHub links work
- [ ] Resize to phone width — still readable, no horizontal scroll
- [ ] No placeholder text anywhere: no "Lorem", no "TODO", no "Coming soon"

---

## Part 4 — Dashboard (15 min)

Log in with the credentials Run 8 printed.

**Overview**
- [ ] Five KPI tiles populated, no zeros or NaN
- [ ] Numbers are monospaced and don't jitter on refresh
- [ ] Sparklines render
- [ ] Case feed shows cases
- [ ] Exceptions table has entries

**Cases**
- [ ] Table populated, filters work
- [ ] Synthetic cases carry a visible SYNTHETIC pill
- [ ] `cause_by` badge shows both `rule` and `llm` — and `rule` is the majority

**Case detail** — this is the view your video depends on. Spend time here.
- [ ] Timeline renders left to right: ingested → diagnosed → planned → gated → executed → outcome
- [ ] Each node has a metric and a timestamp
- [ ] Gate results visible, failures in red with a reason
- [ ] Audit log below, chain-verified badge present
- [ ] Open a **blocked** case — it should clearly show which gate stopped it and why

**Exceptions**
- [ ] Populated with real reasons, not a generic string

**Policy**
- [ ] `policy.yaml` rendered readable
- [ ] Kill switch toggles with a confirm dialog

**States** — stop the worker, then reload a few pages
- [ ] Loading shows skeletons, not spinners
- [ ] Nothing crashes to a blank screen

---

## Part 5 — The engine actually works (10 min)

This is the part a judge will probe.

```bash
pnpm eval
cat eval/RESULTS.md
```

- [ ] Three arms present with different numbers
- [ ] Arm C beats Arm B on **cost per rupee recovered**
- [ ] False nudges reported — a non-zero number is fine and honest
- [ ] Wasted terminal attempts for Arm C is **0**
- [ ] Quiet-hours violations is **0**
- [ ] Diagnosis precision/recall present
- [ ] Threats-to-validity section present

**Restart resilience:**
```bash
# start worker, let it schedule, kill it, restart it
pnpm --filter worker dev
# Ctrl-C mid-run, then restart
```
- [ ] Boot logs show the catch-up pass
- [ ] No duplicate actions created for the same plan

**Live webhook:**
- [ ] Create a test payment in Razorpay that fails
- [ ] It appears in `raw_events`, then as a case, diagnosed within a minute

---

## Part 6 — Production (5 min)

- [ ] Vercel URL loads the landing page
- [ ] Dashboard reachable and login works
- [ ] Railway worker running; logs show activity
- [ ] Railway Serverless toggle is **OFF**
- [ ] Razorpay webhook points at the Vercel URL, and its delivery log shows 200s
- [ ] README has the live URLs

---

## Part 7 — Judge's-eye pass (5 min)

Read your own README as a stranger would.

- [ ] The two-lane data disclosure is near the top and easy to understand
- [ ] The problem is stated in one number
- [ ] The results table is present and legible
- [ ] Full-depth vs light-depth surfaces stated plainly
- [ ] Anything cut is disclosed
- [ ] `docs/` reflects what was actually built
- [ ] No sentence in the README overclaims what you can demo

**The one question to ask yourself:** if a Razorpay engineer opened this repo cold, would anything make them think a number was inflated? If yes, fix the number or fix the framing.

---

## Fix list

Collect every ❌, then paste to a fresh Claude Code chat:

```
Read docs/INSTRUCTIONS.md and docs/CLAUDE_CONTEXT.md.
The human completed the test pass in docs/TESTING_GUIDE.md.
These items failed:

1. [item] — [what you observed]
2. ...

Fix them autonomously in priority order: security first, then correctness,
then UI. Verify each fix by running it. Do not touch anything not on this
list. Commit, push, and report each fix with how you verified it.
```

---

## Then

1. **Record the video** — beat structure in `BUILD_PLAN.md`, Day 6. Set `DEMO_TIME_SCALE=360` first so hour-long delays compress to seconds.
2. **Fill the form** — 12 answers. Question 12, *what broke and how you got out*, is the one they read first. Pull the real story from `docs/CLAUDE_CONTEXT.md` known-issues history and the git log. Use a real bug with a real commit link. An invented one reads as invented.
3. **Submit.**
