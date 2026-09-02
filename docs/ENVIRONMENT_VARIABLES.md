# ENVIRONMENT_VARIABLES

Three environments: **local**, **Vercel** (web), **Railway** (worker).

Never commit a value. `.env.example` carries keys only. `.env.local` is gitignored.

**`.env.local` ships pre-filled.** Two fields are blank and the human generates them before Run 1: `RAZORPAY_WEBHOOK_SECRET` and `AUTH_SECRET`. Claude Code reads `.env.local` from disk — it never needs a value pasted into a chat, and should never echo one into a log, a commit, a doc, or a phase report.

---

## The map

| Variable | Local | Vercel | Railway | Source |
|---|:---:|:---:|:---:|---|
| `DATABASE_URL` | ✅ | ✅ | ✅ | Neon — **pooled** string |
| `RAZORPAY_KEY_ID` | ✅ | ✅ | ✅ | Razorpay dashboard, test mode |
| `RAZORPAY_KEY_SECRET` | ✅ | ✅ | ✅ | Razorpay, shown once |
| `RAZORPAY_WEBHOOK_SECRET` | ✅ | ✅ | — | You generate it |
| `GROQ_API_KEY` | ✅ | — | ✅ | console.groq.com |
| `AUTH_SECRET` | ✅ | ✅ | — | You generate it |
| `AUTH_URL` | ✅ | ✅ | — | Deployment URL |
| `DEMO_TIME_SCALE` | ✅ | ✅ | ✅ | You set it |
| `LLM_MODEL_DIAGNOSIS` | ✅ | — | ✅ | You set it |
| `LLM_MODEL_COPY` | ✅ | — | ✅ | You set it |
| `LLM_MODEL_GUARD` | ✅ | — | ✅ | You set it |
| `POLICY_PATH` | ✅ | ✅ | ✅ | You set it |
| `TIMING_STRATEGY` | ✅ | — | ✅ | You set it |
| `NODE_ENV` | ✅ | auto | ✅ | Platform |

**Why the gaps matter:**
- `GROQ_API_KEY` is worker-only — all LLM calls happen there. The web app never needs it, so it never sees it.
- `RAZORPAY_WEBHOOK_SECRET` is web-only — only Vercel verifies signatures.
- `AUTH_*` is web-only — the worker has no users and no public surface.

Least privilege, applied to env vars. If a compromised surface can't read a key, it can't leak it.

---

## Reference

### `DATABASE_URL`
Neon pooled connection string. Must contain `-pooler` in the host.
```
postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```
⚠️ The **direct** endpoint will exhaust connections on a long-running worker. Pooled only.
Region should be `ap-southeast-1` (Singapore). A US region adds ~250ms per query.

### `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
Test mode only. Key id starts `rzp_test_`. The secret is displayed once at generation.

### `RAZORPAY_WEBHOOK_SECRET`
**Not issued by Razorpay.** You generate it and type it into their webhook form; your code verifies HMAC against it.
```bash
openssl rand -hex 32
```

### `AUTH_SECRET`
```bash
openssl rand -base64 32
```

### `AUTH_URL`
`http://localhost:3000` local, `https://<project>.vercel.app` production.

### `DEMO_TIME_SCALE`
Integer divisor for all scheduling delays.
- `1` — real timing (production, eval)
- `360` — 4 hours becomes 40 seconds (video recording)

Every scheduling call must respect it. Retrofitting means touching every call site.

### `LLM_MODEL_*`
Model names live in env because free catalogs change without notice — providers have removed free models with no warning, breaking code that hadn't changed.
```
LLM_MODEL_DIAGNOSIS=openai/gpt-oss-120b
LLM_MODEL_COPY=openai/gpt-oss-20b
LLM_MODEL_GUARD=meta-llama/llama-prompt-guard-2-86m
```

### `POLICY_PATH`
Default `./policy.yaml`. Lets the eval load an alternate policy for comparison.

### `TIMING_STRATEGY`
`static` or `bandit`. Default `static`.

---

## `.env.example`

```bash
# Database — Neon POOLED string, ap-southeast-1
DATABASE_URL=

# Razorpay — test mode
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# Groq
GROQ_API_KEY=
LLM_MODEL_DIAGNOSIS=openai/gpt-oss-120b
LLM_MODEL_COPY=openai/gpt-oss-20b
LLM_MODEL_GUARD=meta-llama/llama-prompt-guard-2-86m

# Auth
AUTH_SECRET=
AUTH_URL=http://localhost:3000

# Behaviour
DEMO_TIME_SCALE=1
POLICY_PATH=./policy.yaml
TIMING_STRATEGY=static
```

---

## Validation

Every variable is Zod-validated at startup in `packages/core/env`. Missing or malformed → **crash immediately** with a clear message naming the variable.

Never `process.env.X ?? 'default'` for anything security-relevant. A silent fallback on a secret is how staging credentials reach production.

---

## Rotation

If a value is ever exposed — pasted into a chat, committed, screenshotted:

| Secret | How |
|---|---|
| Razorpay | Dashboard → API Keys → regenerate. Test-mode only, low stakes. |
| Neon | Project → Roles → reset password. **Do this immediately** — full read/write/drop. |
| Groq | Console → delete key, create new. |
| `AUTH_SECRET` | Regenerate, redeploy. Invalidates sessions. |
| `RAZORPAY_WEBHOOK_SECRET` | Regenerate, update both the dashboard and the env. |
