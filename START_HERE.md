# START HERE

**Your total involvement before testing: about 15 minutes.**

Everything after that is Claude Code's job — code, git, commits, pushes, deployment, documentation. You come back at the end and test.

---

## Step 1 — Put the files in place (2 min)

Unpack this bundle into your local clone of `github.com/PRCSM/Razorpay`.

```
Razorpay/
├─ START_HERE.md
├─ BUILD_PLAN.md
├─ CLAUDE_CODE_PROMPTS.md
├─ README.md
├─ policy.yaml
├─ .env.local              ← already filled in, see Step 2
├─ .env.example
└─ docs/                   ← 11 files
```

Don't commit yet. Claude Code handles the first commit, including the `.gitignore` that protects `.env.local`.

---

## Step 2 — Check `.env.local` (1 min)

The bundle ships with `.env.local` already filled in with your Neon, Razorpay, and Groq values. Two fields are deliberately blank — generate them:

```bash
grep -E "^[A-Z_]+=$" .env.local
# prints RAZORPAY_WEBHOOK_SECRET= and AUTH_SECRET=
# after you fill them, this should print nothing
```

```bash
openssl rand -base64 32     # paste into AUTH_SECRET
openssl rand -hex 32        # paste into RAZORPAY_WEBHOOK_SECRET
```

⚠️ **`.env.local` must never reach GitHub.** Your repo has to be public for the submission, and it contains a live database password with full read/write/drop. Claude Code writes a `.gitignore` covering `.env*` in its very first commit, before anything else — but if you commit manually before then, it's exposed. Just don't.

---

## Step 3 — Install the tooling (10 min)

```bash
node -v          # need 20+.  nvm install 20
npm i -g pnpm
pnpm -v
git --version
```

Plus ngrok, needed on Day 1 so Razorpay can reach your machine:
```bash
# download from ngrok.com, then:
ngrok version
```

Optional: Docker Desktop, if you want offline Postgres.

---

## Step 4 — Authorise git for Claude Code (2 min)

Claude Code commits and pushes on its own. Make sure it can:

```bash
git config --global user.name "Paikhomba Wahengbam"
git config --global user.email "wahengbamkumar546@gmail.com"

# confirm push works without an interactive prompt
git remote -v
git push
```

If push asks for a password, set up a credential helper or an SSH key first. Claude Code cannot type your GitHub password, and a blocked push mid-phase stops the run.

---

## Step 5 — Start it (30 seconds)

Open the folder in VS Code. Open Claude Code. Paste the **RUN 1** block from `CLAUDE_CODE_PROMPTS.md`.

Then leave it alone.

---

## What happens next

Claude Code executes eight runs. In each one it plans, builds, tests itself against explicit completion criteria, fixes its own failures, updates the docs, commits, and pushes.

**It does not ask your permission to proceed.** It only stops for the four reasons in the HALT protocol (`docs/INSTRUCTIONS.md`):

1. A credential is missing or rejected
2. An external service is down or blocking
3. A business rule is genuinely ambiguous and guessing would be unsafe
4. Completion criteria failed twice and self-correction didn't work

If it halts, it tells you exactly what it needs in one message. Everything else it handles.

---

## The three moments you're needed

| When | What | Time |
|---|---|---|
| **After Run 2** | Start ngrok, paste the URL into Razorpay's webhook settings | 5 min |
| **After Run 8** | Test everything using `docs/TESTING_GUIDE.md` | 60 min |
| **After testing** | Record the video, submit the form | 3 hrs |

That's it. The webhook URL is the only thing Claude Code genuinely cannot do — Razorpay's dashboard has no API for it and ngrok prints a fresh URL each session.

Run 2 ends by telling you the exact URL and the exact events to tick.

---

## If you want to check in

You don't have to, but if you want to see where things stand:

```bash
cat docs/CLAUDE_CONTEXT.md      # current phase, what's done, what's broken
git log --oneline               # what shipped
```

`CLAUDE_CONTEXT.md` is rewritten at the end of every run. It's the honest status of the project at any moment.

---

## If a run goes wrong

Start a **fresh chat** and paste:

```
Read docs/INSTRUCTIONS.md and docs/CLAUDE_CONTEXT.md.
The previous run for [PHASE] failed or was interrupted.
Inspect the repo, determine the actual state, and complete that phase
per its block in CLAUDE_CODE_PROMPTS.md. Then continue autonomously.
```

Never resume a phase in a chat that's already long. Context bloat is what makes Claude Code start guessing instead of reading.

---

## Ready?

- [ ] Files unpacked into the repo
- [ ] `.env.local` complete, both secrets generated
- [ ] `node -v` shows 20+, `pnpm -v` works
- [ ] `git push` works without prompting
- [ ] ngrok installed

All five ticked → paste **RUN 1**.
