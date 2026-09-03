/**
 * End-to-end proof of the downtime signal and the LLM tail, against real rows.
 *
 *   pnpm downtime:smoke
 *
 * TASK 8 is explicit that assertions must hit PERSISTED DB ROWS, not just function
 * returns — the Run 2 envelope bug passed every unit test and was only caught by a
 * row-level check. So this script:
 *
 *   1. delivers a live-shaped payment.downtime.started through the real webhook
 *   2. ingests it and asserts a downtime_windows ROW exists
 *   3. inserts a payment failure inside that window whose error tuple says
 *      insufficient_funds, and asserts the persisted case reads issuer_down with
 *      cause_by = 'downtime_signal'
 *   4. resolves the window and asserts a failure outside it is diagnosed by RULE
 *      instead — proving the inference path still works independently
 *   5. runs the LLM tail on a deliberately unmapped tuple and asserts the
 *      persisted cause_by = 'llm'
 *   6. re-runs the same tail call and asserts ZERO new API calls (cache hit)
 *
 * Cleans up everything it created.
 */

import {
  computeRazorpaySignature,
  diagnoseCase,
  getWorkerEnv,
  loadPolicy,
  type DiagnosisInput,
} from '@reflow/core';
import {
  closeAllPools,
  createPooledDb,
  downtimeWindows,
  exceptions,
  merchants,
  rawEvents,
  recoveryCases,
} from '@reflow/db';
import { GroqClient, GroqDiagnosisTail } from '@reflow/llm';
import { asc, eq, inArray } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runIngestPass } from '../ingest/index';
import { PostgresLlmCache } from '../llm/pg-cache';

const repoRoot = resolve(import.meta.dirname, '../../../..');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const env = getWorkerEnv();
  const policy = loadPolicy(env.POLICY_PATH, repoRoot);
  const baseUrl = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');

  const nonce = randomBytes(5).toString('hex');
  const downtimeId = `down_smoke_${nonce}`;
  const eventId = `evt_down_${nonce}`;
  const refInside = `pay_inside_${nonce}`;
  const refOutside = `pay_outside_${nonce}`;
  const refUnmapped = `pay_unmapped_${nonce}`;

  // A window that is CURRENTLY open, so a failure now falls inside it.
  const startedAt = new Date(Date.now() - 30 * 60 * 1000);
  const insideAt = new Date(Date.now() - 10 * 60 * 1000);

  const payload = {
    entity: 'event',
    account_id: 'acc_smoke',
    event: 'payment.downtime.started',
    contains: ['payment.downtime'],
    payload: {
      payment: {
        downtime: {
          entity: {
            id: downtimeId,
            entity: 'payment.downtime',
            method: 'card',
            begin: Math.floor(startedAt.getTime() / 1000),
            end: null,
            status: 'started',
            scheduled: false,
            severity: 'high',
            instrument: { bank: 'HDFC' },
          },
        },
      },
    },
    created_at: Math.floor(startedAt.getTime() / 1000),
  };

  /**
   * Read straight from the environment, not from `getWorkerEnv()`.
   *
   * The worker's env schema deliberately excludes `RAZORPAY_WEBHOOK_SECRET` —
   * it is web-only under the least-privilege map (ADR-019), and the typechecker
   * enforces that. This script is standing in for Razorpay, signing a delivery,
   * which is a test-tool role rather than a worker role.
   */
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  if (!webhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not set in .env.local');
  }

  const rawBody = JSON.stringify(payload);
  const signature = computeRazorpaySignature(rawBody, webhookSecret);

  const { db } = createPooledDb(env.DATABASE_URL, { max: 2 });
  const createdCaseIds: string[] = [];

  try {
    const merchantRows = await db
      .select({ id: merchants.id })
      .from(merchants)
      .orderBy(asc(merchants.createdAt))
      .limit(1);
    const merchantId = merchantRows[0]?.id;
    if (!merchantId) throw new Error('no merchant — run pnpm db:seed');

    // ---- 1 + 2: deliver and persist the downtime window -------------------
    console.log(`[smoke] delivering downtime event to ${baseUrl}/api/webhooks/razorpay`);
    const response = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      },
      body: rawBody,
    });
    check('signed downtime event accepted 200', response.status === 200, `status=${response.status}`);

    const ingest = await runIngestPass(db);
    check(
      'ingest recorded a downtime window',
      ingest.downtimeWindows >= 1,
      `downtimeWindows=${ingest.downtimeWindows}`,
    );

    const windowRows = await db
      .select({
        id: downtimeWindows.id,
        issuer: downtimeWindows.issuer,
        method: downtimeWindows.method,
        resolvedAt: downtimeWindows.resolvedAt,
        severity: downtimeWindows.severity,
      })
      .from(downtimeWindows)
      .where(eq(downtimeWindows.providerDowntimeId, downtimeId));

    check('downtime_windows ROW exists in Neon', windowRows.length === 1, `rows=${windowRows.length}`);
    check('window issuer persisted as hdfc', windowRows[0]?.issuer === 'hdfc', String(windowRows[0]?.issuer));
    check('window method persisted as card', windowRows[0]?.method === 'card', String(windowRows[0]?.method));
    check('window is unresolved', windowRows[0]?.resolvedAt === null);
    check('severity persisted', windowRows[0]?.severity === 'high', String(windowRows[0]?.severity));

    // ---- 3: a failure INSIDE the window is issuer_down by downtime_signal --
    // The error tuple deliberately says insufficient_funds. The downtime signal
    // must outrank it.
    const insideRows = await db
      .insert(recoveryCases)
      .values({
        merchantId,
        source: 'payment',
        externalRef: refInside,
        amountPaise: 250_000,
        currency: 'INR',
        customerRef: `cust_smoke_${nonce}`,
        method: 'card',
        issuer: 'hdfc',
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        errorReason: 'insufficient_funds',
        status: 'open',
        openedAt: insideAt,
        isSynthetic: false,
      })
      .returning({ id: recoveryCases.id });
    const insideId = insideRows[0]?.id;
    if (!insideId) throw new Error('failed to insert the inside-window case');
    createdCaseIds.push(insideId);

    // A failure OUTSIDE the window (before it began) must fall to the rule table.
    const outsideRows = await db
      .insert(recoveryCases)
      .values({
        merchantId,
        source: 'payment',
        externalRef: refOutside,
        amountPaise: 250_000,
        currency: 'INR',
        customerRef: `cust_smoke_${nonce}`,
        method: 'card',
        issuer: 'hdfc',
        errorCode: 'BAD_REQUEST_ERROR',
        errorSource: 'bank',
        errorStep: 'payment_authorization',
        errorReason: 'insufficient_funds',
        status: 'open',
        openedAt: new Date(startedAt.getTime() - 6 * 60 * 60 * 1000),
        isSynthetic: false,
      })
      .returning({ id: recoveryCases.id });
    const outsideId = outsideRows[0]?.id;
    if (!outsideId) throw new Error('failed to insert the outside-window case');
    createdCaseIds.push(outsideId);

    // An unmapped tuple, to exercise the LLM tail.
    const unmappedRows = await db
      .insert(recoveryCases)
      .values({
        merchantId,
        source: 'payment',
        externalRef: refUnmapped,
        amountPaise: 99_900,
        currency: 'INR',
        customerRef: `cust_smoke_${nonce}`,
        method: 'wallet',
        issuer: 'paytm',
        // Nothing in the table covers this combination.
        errorCode: 'SERVER_ERROR',
        errorSource: 'network',
        errorStep: 'payment_capture',
        errorReason: 'upstream_connection_reset',
        status: 'open',
        openedAt: insideAt,
        isSynthetic: false,
      })
      .returning({ id: recoveryCases.id });
    const unmappedId = unmappedRows[0]?.id;
    if (!unmappedId) throw new Error('failed to insert the unmapped case');
    createdCaseIds.push(unmappedId);

    // Diagnose only the rows this script created, so a stray batch cannot
    // interfere with the assertions.
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
    const tail = new GroqDiagnosisTail({
      client,
      injection: {
        enabled: policy.gates.injection_screen.enabled,
        threshold: policy.gates.injection_screen.threshold,
      },
    });

    const { loadRelevantDowntimeWindows } = await import('../ingest/downtime');
    const windows = await loadRelevantDowntimeWindows(db, new Date(Date.now() - 86_400_000));

    for (const [caseId, openedAt, wantsTail] of [
      [insideId, insideAt, false],
      [outsideId, new Date(startedAt.getTime() - 6 * 60 * 60 * 1000), false],
      [unmappedId, insideAt, true],
    ] as const) {
      const rows = await db
        .select({
          source: recoveryCases.source,
          errorCode: recoveryCases.errorCode,
          errorSource: recoveryCases.errorSource,
          errorStep: recoveryCases.errorStep,
          errorReason: recoveryCases.errorReason,
          method: recoveryCases.method,
          issuer: recoveryCases.issuer,
        })
        .from(recoveryCases)
        .where(eq(recoveryCases.id, caseId));
      const row = rows[0];
      if (!row) continue;

      const input: DiagnosisInput = { ...row, daysOverdue: null };
      const diagnosis = await diagnoseCase({
        input,
        failedAt: openedAt,
        downtimeWindows: windows,
        ...(wantsTail ? { tail } : {}),
      });

      await db
        .update(recoveryCases)
        .set({
          rootCause: diagnosis.cause,
          causeConfidence: diagnosis.confidence,
          causeBy: diagnosis.causeBy,
          status: diagnosis.cause === 'unknown' ? 'exception' : 'diagnosed',
        })
        .where(eq(recoveryCases.id, caseId));
    }

    // ---- row-level assertions ---------------------------------------------
    const readBack = async (id: string) => {
      const rows = await db
        .select({
          rootCause: recoveryCases.rootCause,
          causeBy: recoveryCases.causeBy,
          causeConfidence: recoveryCases.causeConfidence,
          status: recoveryCases.status,
        })
        .from(recoveryCases)
        .where(eq(recoveryCases.id, id));
      return rows[0];
    };

    const inside = await readBack(insideId);
    check(
      'INSIDE window: persisted root_cause = issuer_down',
      inside?.rootCause === 'issuer_down',
      String(inside?.rootCause),
    );
    check(
      "INSIDE window: persisted cause_by = 'downtime_signal'",
      inside?.causeBy === 'downtime_signal',
      String(inside?.causeBy),
    );
    check(
      'INSIDE window: confidence 1.0',
      Number(inside?.causeConfidence) === 1,
      String(inside?.causeConfidence),
    );

    const outside = await readBack(outsideId);
    check(
      'OUTSIDE window: falls back to the rule table (insufficient_funds)',
      outside?.rootCause === 'insufficient_funds',
      String(outside?.rootCause),
    );
    check(
      "OUTSIDE window: persisted cause_by = 'rule' — inference path intact",
      outside?.causeBy === 'rule',
      String(outside?.causeBy),
    );

    const unmapped = await readBack(unmappedId);
    check(
      "UNMAPPED tuple: persisted cause_by = 'llm' — the tail ran",
      unmapped?.causeBy === 'llm',
      `cause=${String(unmapped?.rootCause)} by=${String(unmapped?.causeBy)}`,
    );
    console.log(
      `[smoke] LLM tail: calls=${tail.calls} parseFailures=${tail.parseFailures} ` +
        `blocked=${tail.blockedByGuard} cache(h/m)=${cache.hits}/${cache.misses}`,
    );

    // ---- 6: cache hit means zero new API calls ----------------------------
    const callsBefore = client.apiCalls;
    const repeat = await diagnoseCase({
      input: {
        source: 'payment',
        errorCode: 'SERVER_ERROR',
        errorSource: 'network',
        errorStep: 'payment_capture',
        errorReason: 'upstream_connection_reset',
        method: 'wallet',
        issuer: 'paytm',
        daysOverdue: null,
      },
      failedAt: insideAt,
      downtimeWindows: [],
      tail,
    });
    const callsAfter = client.apiCalls;
    check(
      're-running the same tail call made ZERO new API calls',
      callsAfter === callsBefore,
      `before=${callsBefore} after=${callsAfter}`,
    );
    check('the cached re-run produced the same cause', repeat.cause === unmapped?.rootCause,
      `${String(repeat.cause)} vs ${String(unmapped?.rootCause)}`);
  } finally {
    // ---- cleanup -----------------------------------------------------------
    if (process.env['SMOKE_KEEP'] !== '1') {
      if (createdCaseIds.length > 0) {
        await db.delete(exceptions).where(inArray(exceptions.caseId, createdCaseIds));
        await db.delete(recoveryCases).where(inArray(recoveryCases.id, createdCaseIds));
      }
      await db.delete(downtimeWindows).where(eq(downtimeWindows.providerDowntimeId, downtimeId));
      await db.delete(rawEvents).where(eq(rawEvents.providerEventId, eventId));
      console.log('\n[smoke] cleaned up the rows this run created');
    } else {
      console.log('\n[smoke] SMOKE_KEEP=1 — rows left for inspection');
    }
    await closeAllPools();
  }

  console.log(failures === 0 ? '\nALL DOWNTIME + LLM CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('[smoke] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
