/**
 * Lazy, per-case explanations.
 *
 * TASK 5 requires these be generated ON VIEW, one at a time, never for the batch.
 * The arithmetic is the reason: 500 cases against an 8,000 TPM ceiling is roughly
 * 100 minutes and most of a day's token budget, spent on prose nobody has asked
 * to read.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN THE WORKER AND NOT IN THE WEB APP
 *
 * `GROQ_API_KEY` is worker-only by design and must never be added to Vercel
 * (docs/ENVIRONMENT_VARIABLES.md, least privilege). The web app therefore cannot
 * make an LLM call at all — the typechecker enforces it, since `webEnvSchema`
 * has no Groq key.
 *
 * So "lazy on view" is satisfied worker-side: the dashboard reads whatever
 * explanation already exists, and generation happens here, per case, on demand.
 * Nothing is pre-generated. See ADR-030.
 * ---------------------------------------------------------------------------
 */

import { explainCase, type GroqClient, type InjectionScreenOptions } from '@reflow/llm';
import { recoveryCases, type PooledDb } from '@reflow/db';
import { eq } from 'drizzle-orm';

export interface ExplainCaseResult {
  readonly ok: boolean;
  readonly caseId: string;
  readonly text: string | null;
  readonly cached: boolean;
  readonly reason: string | null;
}

/**
 * Explain ONE case.
 *
 * Cache-first via the shared `llm_cache`, so opening the same case twice costs
 * nothing and the wording stays stable between views.
 *
 * Refuses to explain an undiagnosed case: an explanation of `null` would be the
 * model speculating, which is exactly what the taxonomy exists to prevent.
 */
export async function explainOneCase(
  db: PooledDb,
  caseId: string,
  client: GroqClient,
  injection: InjectionScreenOptions,
): Promise<ExplainCaseResult> {
  const rows = await db
    .select({
      id: recoveryCases.id,
      source: recoveryCases.source,
      rootCause: recoveryCases.rootCause,
      causeBy: recoveryCases.causeBy,
      method: recoveryCases.method,
      issuer: recoveryCases.issuer,
      errorReason: recoveryCases.errorReason,
      amountPaise: recoveryCases.amountPaise,
    })
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { ok: false, caseId, text: null, cached: false, reason: 'case not found' };
  }

  if (row.rootCause === null || row.rootCause === 'unknown') {
    return {
      ok: false,
      caseId,
      text: null,
      cached: false,
      reason:
        'case has no diagnosed cause — explaining it would be speculation, so the dashboard ' +
        'shows the exception reason instead',
    };
  }

  const outcome = await explainCase(
    {
      source: row.source,
      rootCause: row.rootCause,
      method: row.method,
      issuer: row.issuer,
      errorReason: row.errorReason,
      amountPaise: row.amountPaise,
      causeBy: row.causeBy ?? 'rule',
    },
    client,
    injection,
  );

  if (!outcome.ok) {
    return { ok: false, caseId, text: null, cached: false, reason: outcome.reason };
  }

  return { ok: true, caseId, text: outcome.text, cached: outcome.cached, reason: null };
}
