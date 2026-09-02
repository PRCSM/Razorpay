/**
 * Environment validation — the IMPURE half. One of two documented boundary
 * adapters in `packages/core` (the other is `policy/load.ts`).
 *
 * This is the only file in core allowed to read `process.env`, and it is
 * exempted from the purity fence in `eslint.config.mjs` for exactly that
 * reason. It contains no decision logic: it reads the ambient environment and
 * hands it to the pure `parseEnv` in `./schema.ts`.
 *
 * Validation is memoised on FIRST ACCESS rather than at module import.
 *
 * That is not a relaxation of the rule — the schema is identical and a missing
 * variable still throws before any code can use it. It is what makes "crash at
 * startup" mean *process* startup instead of *bundler* evaluation: Next.js
 * imports every module while building, so validating at import time would make
 * a production build fail on a machine that legitimately has no secrets, and
 * would tempt exactly the kind of `?? 'default'` fallback that
 * docs/ENVIRONMENT_VARIABLES.md forbids.
 */

import type { z } from 'zod';
import {
  dbEnvSchema,
  fullEnvSchema,
  parseEnv,
  webEnvSchema,
  workerEnvSchema,
  type DbEnv,
  type EnvSource,
  type FullEnv,
  type WebEnv,
  type WorkerEnv,
} from './schema.js';

/** Read the ambient environment. The single point of impurity. */
function ambient(): EnvSource {
  return process.env as EnvSource;
}

function memoise<T>(schema: z.ZodType<T>, surface: string): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) {
      cached = parseEnv(schema, ambient(), surface);
    }
    return cached;
  };
}

/** Validated web environment. Throws `EnvValidationError` on first access if invalid. */
export const getWebEnv: () => WebEnv = memoise(webEnvSchema, 'web (Vercel)');

/** Validated worker environment. Throws `EnvValidationError` on first access if invalid. */
export const getWorkerEnv: () => WorkerEnv = memoise(workerEnvSchema, 'worker (Railway)');

/** Every variable in .env.example. For migrations, seeds, and the eval harness. */
export const getFullEnv: () => FullEnv = memoise(fullEnvSchema, 'full (.env.example)');

/** Just what a migration or seed needs. */
export const getDbEnv: () => DbEnv = memoise(dbEnvSchema, 'database tooling');
