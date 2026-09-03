/**
 * Score the rule engine against the labelled oracle.
 *
 *   pnpm score:diagnosis
 *
 * Reads the 500 synthetic cases from Neon and compares `diagnoseByRulesOnly` —
 * the rule table in isolation, no LLM, no downtime — against
 * `ground_truth.true_root_cause`.
 *
 * IMPORTANT, and the reason this script is separate from the rule table: the
 * table was built from docs/POLICY_SPEC.md and Razorpay's error semantics, NOT by
 * reading the generator. Nothing here feeds back into the table. If accuracy is
 * poor, that gets reported — tuning the rules against this oracle would make the
 * Run 7 diagnosis metrics circular and worthless.
 */

import { diagnoseByRulesOnly, type DiagnosisInput } from '@reflow/core';
import { closeAllPools, createPooledDb, recoveryCases } from '@reflow/db';
import { eq } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

interface PerCause {
  truth: number;
  predicted: number;
  correct: number;
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '  n/a';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const { db } = createPooledDb(databaseUrl, { max: 1 });

  try {
    const rows = await db
      .select({
        id: recoveryCases.id,
        source: recoveryCases.source,
        errorCode: recoveryCases.errorCode,
        errorSource: recoveryCases.errorSource,
        errorStep: recoveryCases.errorStep,
        errorReason: recoveryCases.errorReason,
        method: recoveryCases.method,
        issuer: recoveryCases.issuer,
        groundTruth: recoveryCases.groundTruth,
      })
      .from(recoveryCases)
      .where(eq(recoveryCases.isSynthetic, true));

    if (rows.length === 0) {
      throw new Error('No synthetic cases found. Run `pnpm eval:seed 500 --seed 42` first.');
    }

    const stats = new Map<string, PerCause>();
    const bump = (cause: string, field: keyof PerCause): void => {
      const entry = stats.get(cause) ?? { truth: 0, predicted: 0, correct: 0 };
      entry[field] += 1;
      stats.set(cause, entry);
    };

    let matched = 0;
    let unmatched = 0;
    let correct = 0;
    const confusions = new Map<string, number>();
    const bySource = new Map<string, { total: number; correct: number; unmatched: number }>();

    for (const row of rows) {
      const truth = (row.groundTruth as { true_root_cause?: string } | null)?.true_root_cause;
      if (typeof truth !== 'string') continue;

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

      const { cause: predicted } = diagnoseByRulesOnly(input);

      bump(truth, 'truth');
      if (predicted !== 'unknown') bump(predicted, 'predicted');

      const sourceStat = bySource.get(row.source) ?? { total: 0, correct: 0, unmatched: 0 };
      sourceStat.total += 1;

      if (predicted === 'unknown') {
        unmatched += 1;
        sourceStat.unmatched += 1;
      } else {
        matched += 1;
        if (predicted === truth) {
          correct += 1;
          sourceStat.correct += 1;
          bump(truth, 'correct');
        } else {
          const key = `${truth} -> ${predicted}`;
          confusions.set(key, (confusions.get(key) ?? 0) + 1);
        }
      }
      bySource.set(row.source, sourceStat);
    }

    const total = rows.length;

    console.log('=== RULE ENGINE vs GROUND TRUTH ===');
    console.log('Rules only. No LLM, no downtime signal.\n');
    console.log(`cases scored        : ${total}`);
    console.log(`rule table matched  : ${matched}  (${pct(matched, total)}) <- coverage`);
    console.log(`no rule matched     : ${unmatched}  (${pct(unmatched, total)}) <- LLM tail territory`);
    console.log(`correct             : ${correct}  (${pct(correct, total)}) <- overall accuracy`);
    console.log(
      `precision on matched: ${pct(correct, matched)} <- when it answers, how often it is right`,
    );

    console.log('\n-- per source --');
    console.log('source        total  correct   accuracy   unmatched');
    for (const [source, s] of [...bySource.entries()].sort()) {
      console.log(
        `  ${source.padEnd(12)}${String(s.total).padStart(4)}   ${String(s.correct).padStart(4)}    ` +
          `${pct(s.correct, s.total).padStart(7)}      ${String(s.unmatched).padStart(4)}`,
      );
    }

    console.log('\n-- per cause (recall = found / actually present) --');
    console.log('cause                            truth  pred  correct   recall  precision');
    for (const [cause, s] of [...stats.entries()].sort((a, b) => b[1].truth - a[1].truth)) {
      console.log(
        `  ${cause.padEnd(30)} ${String(s.truth).padStart(5)} ${String(s.predicted).padStart(5)} ` +
          `${String(s.correct).padStart(8)}  ${pct(s.correct, s.truth).padStart(7)}   ` +
          `${pct(s.correct, s.predicted).padStart(7)}`,
      );
    }

    if (confusions.size > 0) {
      console.log('\n-- confusions (truth -> predicted) --');
      for (const [key, count] of [...confusions.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${key}`);
      }
    } else {
      console.log('\n-- confusions: none. Every rule match agreed with the label. --');
    }

    console.log('\n=== END SCORE ===');
    console.log(
      'Note: the rule table was written from POLICY_SPEC.md and Razorpay error\n' +
        'semantics before this was run. It was not tuned against these labels.',
    );
  } finally {
    await closeAllPools();
  }
}

main().catch((error: unknown) => {
  console.error('[score] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
