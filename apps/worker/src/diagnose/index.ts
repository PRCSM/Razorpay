/**
 * The diagnose stage: open cases → a root cause on every one.
 *
 * Reads `recovery_cases` where `root_cause IS NULL`, runs core's `diagnoseCase`,
 * and writes `root_cause`, `cause_confidence`, and `cause_by` back. Cases that end
 * up `unknown` get an `exceptions` row, so nothing is silently left undiagnosed
 * (docs/INSTRUCTIONS.md hard rule 6).
 *
 * All the decision logic lives in `packages/core`. This file is wiring: load rows,
 * call the pure function, persist the result.
 */

import {
  diagnoseCase,
  summariseDiagnoses,
  type Diagnosis,
  type DiagnosisInput,
  type DiagnosisTailPort,
  type DowntimeWindow,
} from '@reflow/core';
import { exceptions, recoveryCases, type PooledDb } from '@reflow/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { loadRelevantDowntimeWindows } from '../ingest/downtime';

export interface DiagnoseOptions {
  readonly batchSize?: number;
  /** Omit to run rules-only. */
  readonly tail?: DiagnosisTailPort;
  /** Include synthetic cases. The eval lane needs this; live operation does not. */
  readonly includeSynthetic?: boolean;
  readonly now?: () => Date;
  /** Progress callback, so a 500-case run is not silent. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface DiagnoseSummary {
  readonly scanned: number;
  readonly diagnosed: number;
  readonly exceptionsCreated: number;
  readonly failed: number;
  readonly byRule: number;
  readonly byLlm: number;
  readonly byDowntimeSignal: number;
  readonly unknown: number;
  readonly ruleShare: number;
  readonly llmShare: number;
  readonly downtimeShare: number;
  readonly unknownRate: number;
  readonly parseFailureRate: number;
  readonly llmCalls: number;
  readonly cacheHits: number;
  readonly causeCounts: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

/**
 * Diagnose one batch.
 *
 * Downtime windows are loaded once for the whole batch and matched in memory by
 * the pure matcher, rather than a query per case.
 */
export async function runDiagnosePass(
  db: PooledDb,
  options: DiagnoseOptions = {},
): Promise<DiagnoseSummary> {
  const batchSize = options.batchSize ?? 1000;
  const now = options.now ?? (() => new Date());
  const includeSynthetic = options.includeSynthetic ?? true;

  const conditions = includeSynthetic
    ? isNull(recoveryCases.rootCause)
    : and(isNull(recoveryCases.rootCause), eq(recoveryCases.isSynthetic, false));

  const pending = await db
    .select({
      id: recoveryCases.id,
      source: recoveryCases.source,
      errorCode: recoveryCases.errorCode,
      errorSource: recoveryCases.errorSource,
      errorStep: recoveryCases.errorStep,
      errorReason: recoveryCases.errorReason,
      method: recoveryCases.method,
      issuer: recoveryCases.issuer,
      openedAt: recoveryCases.openedAt,
      isSynthetic: recoveryCases.isSynthetic,
    })
    .from(recoveryCases)
    .where(conditions)
    .orderBy(asc(recoveryCases.openedAt))
    .limit(batchSize);

  if (pending.length === 0) {
    return emptySummary();
  }

  // Oldest case in the batch bounds which downtime windows could possibly apply.
  const earliest = pending.reduce<Date>(
    (min, row) => (row.openedAt < min ? row.openedAt : min),
    pending[0]?.openedAt ?? now(),
  );
  const windows: readonly DowntimeWindow[] = await loadRelevantDowntimeWindows(db, earliest);

  const diagnoses: Diagnosis[] = [];
  const causeCounts: Record<string, number> = {};
  const warnings: string[] = [];
  let diagnosed = 0;
  let exceptionsCreated = 0;
  let failed = 0;

  for (const [index, row] of pending.entries()) {
    try {
      const input: DiagnosisInput = {
        source: row.source,
        errorCode: row.errorCode,
        errorSource: row.errorSource,
        errorStep: row.errorStep,
        errorReason: row.errorReason,
        method: row.method,
        issuer: row.issuer,
        daysOverdue: null,
      };

      const diagnosis = await diagnoseCase({
        input,
        failedAt: row.openedAt,
        downtimeWindows: windows,
        ...(options.tail ? { tail: options.tail } : {}),
      });

      diagnoses.push(diagnosis);
      causeCounts[diagnosis.cause] = (causeCounts[diagnosis.cause] ?? 0) + 1;

      // Case update and any exception row move together: a case marked diagnosed
      // with no exception behind an `unknown` would be a silent hole.
      await db.transaction(async (tx) => {
        await tx
          .update(recoveryCases)
          .set({
            rootCause: diagnosis.cause,
            causeConfidence: diagnosis.confidence,
            causeBy: diagnosis.causeBy,
            status: diagnosis.cause === 'unknown' ? 'exception' : 'diagnosed',
          })
          .where(eq(recoveryCases.id, row.id));

        if (diagnosis.exceptionReason !== null) {
          await tx
            .insert(exceptions)
            .values({
              caseId: row.id,
              reason: diagnosis.exceptionReason,
              needsHuman: true,
            });
        }
      });

      if (diagnosis.exceptionReason !== null) exceptionsCreated += 1;
      diagnosed += 1;

      if (options.onProgress && (index + 1) % 50 === 0) {
        options.onProgress(index + 1, pending.length);
      }
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`FAILED case ${row.id}: ${detail}`);
    }
  }

  const summary = summariseDiagnoses(diagnoses);

  return {
    scanned: pending.length,
    diagnosed,
    exceptionsCreated,
    failed,
    byRule: summary.byRule,
    byLlm: summary.byLlm,
    byDowntimeSignal: summary.byDowntimeSignal,
    unknown: summary.unknown,
    ruleShare: summary.ruleShare,
    llmShare: summary.llmShare,
    downtimeShare: summary.downtimeShare,
    unknownRate: summary.unknownRate,
    parseFailureRate: summary.parseFailureRate,
    llmCalls: summary.llmCalls,
    cacheHits: summary.cacheHits,
    causeCounts,
    warnings,
  };
}

function emptySummary(): DiagnoseSummary {
  return {
    scanned: 0,
    diagnosed: 0,
    exceptionsCreated: 0,
    failed: 0,
    byRule: 0,
    byLlm: 0,
    byDowntimeSignal: 0,
    unknown: 0,
    ruleShare: 0,
    llmShare: 0,
    downtimeShare: 0,
    unknownRate: 0,
    parseFailureRate: 0,
    llmCalls: 0,
    cacheHits: 0,
    causeCounts: {},
    warnings: [],
  };
}

/** Cases still awaiting diagnosis. */
export async function countUndiagnosedCases(db: PooledDb): Promise<number> {
  const result = await db.execute<{ n: string | number }>(
    sql`SELECT COUNT(*) AS n FROM recovery_cases WHERE root_cause IS NULL`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
