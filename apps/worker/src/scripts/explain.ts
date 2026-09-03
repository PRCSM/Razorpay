/**
 * Explain one case, lazily.
 *
 *   pnpm explain                 # picks the most recent diagnosed case
 *   pnpm explain -- <case-uuid>   # a specific case
 *
 * Demonstrates TASK 5: one case, on demand, cache-first. Running it twice makes
 * zero API calls the second time.
 */

import { getWorkerEnv, loadPolicy } from '@reflow/core';
import { closeAllPools, createPooledDb, recoveryCases } from '@reflow/db';
import { GroqClient } from '@reflow/llm';
import { and, desc, isNotNull, ne } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { explainOneCase } from '../explain/index';
import { PostgresLlmCache } from '../llm/pg-cache';

const repoRoot = resolve(import.meta.dirname, '../../../..');

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const env = getWorkerEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);

  const explicitId = process.argv.slice(2).find((a) => !a.startsWith('--'));

  const { db } = createPooledDb(env.DATABASE_URL, { max: 1 });

  try {
    let caseId = explicitId;
    if (!caseId) {
      const rows = await db
        .select({ id: recoveryCases.id, rootCause: recoveryCases.rootCause })
        .from(recoveryCases)
        .where(and(isNotNull(recoveryCases.rootCause), ne(recoveryCases.rootCause, 'unknown')))
        .orderBy(desc(recoveryCases.openedAt))
        .limit(1);
      caseId = rows[0]?.id;
      if (!caseId) throw new Error('no diagnosed case found — run pnpm diagnose first');
      console.log(`[explain] no case id given; using the latest diagnosed case (${rows[0]?.rootCause})`);
    }

    const cache = new PostgresLlmCache(db);
    const client = new GroqClient({
      apiKey: env.GROQ_API_KEY,
      models: {
        diagnosis: env.LLM_MODEL_DIAGNOSIS,
        copy: env.LLM_MODEL_COPY,
        guard: env.LLM_MODEL_GUARD,
      },
      cache,
    });
    const injection = {
      enabled: policy.gates.injection_screen.enabled,
      threshold: policy.gates.injection_screen.threshold,
    };

    console.log(`[explain] case ${caseId}`);
    console.log(`[explain] copy model ${env.LLM_MODEL_COPY}\n`);

    const first = await explainOneCase(db, caseId, client, injection);
    if (!first.ok) {
      console.log(`[explain] no explanation: ${first.reason}`);
      return;
    }
    console.log(`"${first.text}"`);
    console.log(`\n[explain] cached=${first.cached} apiCalls=${client.apiCalls}`);

    // Second view of the same case: must cost nothing.
    const callsBefore = client.apiCalls;
    const second = await explainOneCase(db, caseId, client, injection);
    console.log(
      `[explain] second view: cached=${second.cached} newApiCalls=${client.apiCalls - callsBefore}`,
    );
    console.log(
      second.text === first.text
        ? '[explain] identical text on re-view — stable between dashboard loads'
        : '[explain] WARNING: text changed between views',
    );
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error('[explain] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
