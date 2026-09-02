/**
 * Environment validation — the PURE half.
 *
 * Everything here takes an explicit `source` record and returns a parsed value.
 * Nothing reads `process.env`. That lives in `./load.ts`, the one documented
 * boundary adapter, so this file stays testable and core stays pure.
 *
 * docs/ENVIRONMENT_VARIABLES.md: "Every variable is Zod-validated at startup.
 * Missing or malformed → crash immediately with a clear message naming the
 * variable. Never `process.env.X ?? 'default'` for anything security-relevant."
 *
 * Least privilege is applied per surface, exactly as the map in that document
 * specifies: the web app never sees GROQ_API_KEY, and the worker never sees
 * AUTH_SECRET. A surface that cannot read a key cannot leak it.
 */

import { z } from 'zod';
import { TIMING_STRATEGIES } from '../types/enums.js';

/** A raw environment source. `process.env` is assignable to this. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Thrown when validation fails. Names every offending variable.
 * Never includes a value — an error message must not leak a secret into a log.
 */
export class EnvValidationError extends Error {
  public readonly variables: readonly string[];

  constructor(surface: string, issues: readonly { path: string; message: string }[]) {
    const lines = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    super(
      `Invalid environment for "${surface}". ${issues.length} problem(s):\n${lines}\n\n` +
        `Fix .env.local (local) or the platform's environment settings (Vercel / Railway).\n` +
        `See docs/ENVIRONMENT_VARIABLES.md for where each value comes from.`,
    );
    this.name = 'EnvValidationError';
    this.variables = issues.map((i) => i.path);
  }
}

// ---------------------------------------------------------------------------
// Field-level rules
// ---------------------------------------------------------------------------

/**
 * Neon pooled connection string.
 *
 * The `-pooler` requirement is enforced only for Neon hosts. A local or
 * containerised Postgres (docker-compose, CI) has no pooler endpoint, and
 * refusing it would make the local stack unusable. This is a host-specific
 * rule, not a relaxation: any neon.tech host must still be pooled, because the
 * direct endpoint exhausts connections on a long-running worker.
 */
const databaseUrl = z
  .string()
  .min(1, 'required — Neon pooled connection string')
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid URL, e.g. postgresql://user:pass@host/db?sslmode=require',
      });
      return;
    }
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      ctx.addIssue({
        code: 'custom',
        message: `must use the postgresql:// scheme, got "${url.protocol}//"`,
      });
    }
    if (url.hostname.endsWith('neon.tech') && !url.hostname.includes('-pooler')) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Neon host must be the POOLED endpoint (hostname contains "-pooler"). ' +
          'The direct endpoint exhausts connections on a long-running worker.',
      });
    }
  });

/**
 * Razorpay key id. Test mode only, enforced.
 *
 * docs/ENVIRONMENT_VARIABLES.md: "Test mode only. Key id starts `rzp_test_`."
 * This project executes money actions autonomously, so a live key is rejected
 * outright rather than trusted to a code path being careful.
 */
const razorpayKeyId = z
  .string()
  .min(1, 'required — from the Razorpay dashboard, test mode')
  .refine((v) => v.startsWith('rzp_test_'), {
    message:
      'must be a TEST-mode key starting with "rzp_test_". This project takes money ' +
      'actions autonomously and refuses to run against live credentials.',
  });

const razorpayKeySecret = z
  .string()
  .min(8, 'required — shown once when the Razorpay key pair is generated');

/** You generate this and type it into Razorpay's webhook form. `openssl rand -hex 32`. */
const razorpayWebhookSecret = z
  .string()
  .min(
    32,
    'required, min 32 chars — you generate it (`openssl rand -hex 32`) and paste the ' +
      'same value into the Razorpay webhook form',
  );

const groqApiKey = z.string().min(1, 'required — from console.groq.com').refine(
  (v) => v.startsWith('gsk_'),
  { message: 'Groq API keys start with "gsk_"' },
);

/** `openssl rand -base64 32` → 44 characters. */
const authSecret = z
  .string()
  .min(32, 'required, min 32 chars — generate with `openssl rand -base64 32`');

const authUrl = z
  .string()
  .min(1, 'required — http://localhost:3000 locally, the https deployment URL in production')
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: 'must be an http:// or https:// URL' });
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid absolute URL' });
    }
  });

/**
 * Integer divisor for every scheduling delay. 1 = real time, 360 = 4h becomes 40s.
 * Not defaulted: the difference between real and compressed timing changes what
 * the measured numbers mean, so it must be stated explicitly.
 */
const demoTimeScale = z.coerce
  .number({ message: 'must be an integer (1 = real timing, 360 = demo speed)' })
  .int('must be a whole number')
  .positive('must be >= 1')
  .max(100_000, 'unreasonably large; 360 compresses 4 hours to 40 seconds');

const llmModel = (which: string) =>
  z
    .string()
    .min(1, `required — the Groq model id used for ${which} (free catalogs change without notice)`);

// ---------------------------------------------------------------------------
// Values that docs/ENVIRONMENT_VARIABLES.md explicitly specifies a default for.
// These are documented defaults, not silent fallbacks, and neither is a secret.
// ---------------------------------------------------------------------------

const policyPath = z.string().min(1).default('./policy.yaml');
const timingStrategy = z.enum(TIMING_STRATEGIES).default('static');
const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

// ---------------------------------------------------------------------------
// Per-surface schemas, mirroring the map in docs/ENVIRONMENT_VARIABLES.md
// ---------------------------------------------------------------------------

/** Shared by every surface. */
const commonShape = {
  DATABASE_URL: databaseUrl,
  DEMO_TIME_SCALE: demoTimeScale,
  POLICY_PATH: policyPath,
  NODE_ENV: nodeEnv,
};

/**
 * Web (Vercel): landing page, dashboard, webhook receiver.
 * No GROQ_API_KEY — every LLM call happens in the worker.
 */
export const webEnvSchema = z.object({
  ...commonShape,
  RAZORPAY_KEY_ID: razorpayKeyId,
  RAZORPAY_KEY_SECRET: razorpayKeySecret,
  RAZORPAY_WEBHOOK_SECRET: razorpayWebhookSecret,
  AUTH_SECRET: authSecret,
  AUTH_URL: authUrl,
});

/**
 * Worker (Railway): the recovery loop.
 * No AUTH_* — the worker has no users and no public inbound surface.
 */
export const workerEnvSchema = z.object({
  ...commonShape,
  RAZORPAY_KEY_ID: razorpayKeyId,
  RAZORPAY_KEY_SECRET: razorpayKeySecret,
  GROQ_API_KEY: groqApiKey,
  LLM_MODEL_DIAGNOSIS: llmModel('diagnosis'),
  LLM_MODEL_COPY: llmModel('message copy'),
  LLM_MODEL_GUARD: llmModel('the prompt-injection screen'),
  TIMING_STRATEGY: timingStrategy,
});

/**
 * Every variable in .env.example. Used by tooling that legitimately needs the
 * lot — migrations, seeds, the eval harness — and by the local preflight check.
 */
export const fullEnvSchema = z.object({
  ...commonShape,
  RAZORPAY_KEY_ID: razorpayKeyId,
  RAZORPAY_KEY_SECRET: razorpayKeySecret,
  RAZORPAY_WEBHOOK_SECRET: razorpayWebhookSecret,
  GROQ_API_KEY: groqApiKey,
  LLM_MODEL_DIAGNOSIS: llmModel('diagnosis'),
  LLM_MODEL_COPY: llmModel('message copy'),
  LLM_MODEL_GUARD: llmModel('the prompt-injection screen'),
  AUTH_SECRET: authSecret,
  AUTH_URL: authUrl,
  TIMING_STRATEGY: timingStrategy,
});

/** Only what a database migration or seed needs. */
export const dbEnvSchema = z.object({
  DATABASE_URL: databaseUrl,
  NODE_ENV: nodeEnv,
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type FullEnv = z.infer<typeof fullEnvSchema>;
export type DbEnv = z.infer<typeof dbEnvSchema>;

// ---------------------------------------------------------------------------
// Pure parse entry point
// ---------------------------------------------------------------------------

/**
 * Validate a raw environment source against a schema.
 * Throws `EnvValidationError` naming every offending variable.
 *
 * Pure: the caller supplies `source`. Nothing here reads the ambient process.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource,
  surface: string,
): z.infer<T> {
  // Treat empty and whitespace-only strings as absent. A platform env editor
  // that saved a blank field must fail as "missing", not pass as "".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') {
      cleaned[key] = value;
    }
  }

  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.code === 'invalid_type' ? 'missing' : issue.message,
    }));
    throw new EnvValidationError(surface, issues);
  }
  return result.data;
}
