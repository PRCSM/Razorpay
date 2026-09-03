/**
 * End-to-end webhook smoke test.
 *
 *   pnpm webhook:smoke                                  # against localhost:3000
 *   BASE_URL=https://reflow-puce.vercel.app pnpm webhook:smoke
 *
 * Verifies the whole ingest path against a running server and a real database:
 *
 *   1. a correctly-signed payload is accepted, stored, and becomes a recovery_case
 *   2. the same payload delivered twice yields exactly ONE case
 *   3. an incorrectly-signed payload is rejected with 400
 *   4. a missing signature header is rejected with 400
 *
 * Signs with the RAZORPAY_WEBHOOK_SECRET from .env.local and never prints it.
 * Cleans up the rows it created so it can be re-run.
 */

import { computeRazorpaySignature } from '@reflow/core';
import { closeAllPools, createPooledDb, rawEvents, recoveryCases } from '@reflow/db';
import { eq, sql } from 'drizzle-orm';
import { config as loadDotenv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { runIngestPass } from '../ingest/index';

const repoRoot = resolve(import.meta.dirname, '../../../..');

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

interface PostResult {
  readonly status: number;
  readonly body: string;
}

async function post(
  baseUrl: string,
  body: string,
  headers: Record<string, string>,
): Promise<PostResult> {
  const response = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: await response.text() };
}

async function main(): Promise<void> {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });

  const baseUrl = (process.env['BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
  const secret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];

  if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set in .env.local');
  if (!databaseUrl) throw new Error('DATABASE_URL is not set in .env.local');

  console.log(`[smoke] target: ${baseUrl}/api/webhooks/razorpay\n`);

  // A unique id per run, so repeated runs never collide on the idempotency key.
  const nonce = randomBytes(6).toString('hex');
  const eventId = `evt_smoke_${nonce}`;
  const paymentId = `pay_smoke_${nonce}`;

  // A realistic payment.failed delivery: insufficient funds on an HDFC card.
  const payload = {
    entity: 'event',
    account_id: 'acc_smoke',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: 250_000,
          currency: 'INR',
          status: 'failed',
          method: 'card',
          bank: 'HDFC',
          customer_id: `cust_smoke_${nonce}`,
          error_code: 'BAD_REQUEST_ERROR',
          error_source: 'bank',
          error_step: 'payment_authorization',
          error_reason: 'insufficient_funds',
        },
      },
    },
    created_at: Math.floor(Date.UTC(2026, 1, 14, 10, 30) / 1000),
  };

  const rawBody = JSON.stringify(payload);
  const signature = computeRazorpaySignature(rawBody, secret);

  const { db } = createPooledDb(databaseUrl, { max: 2 });

  try {
    // ---- 3. bad signature -------------------------------------------------
    const tampered = await post(baseUrl, rawBody, {
      'x-razorpay-signature': 'f'.repeat(64),
      'x-razorpay-event-id': `${eventId}_bad`,
    });
    check('incorrectly-signed payload rejected 400', tampered.status === 400, `status=${tampered.status}`);

    // ---- 4. missing signature header --------------------------------------
    const unsigned = await post(baseUrl, rawBody, { 'x-razorpay-event-id': `${eventId}_none` });
    check('missing signature header rejected 400', unsigned.status === 400, `status=${unsigned.status}`);

    const rejectedRows = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n FROM raw_events
      WHERE provider_event_id IN (${`${eventId}_bad`}, ${`${eventId}_none`})
    `);
    check(
      'rejected deliveries stored nothing',
      Number(rejectedRows.rows[0]?.n ?? -1) === 0,
      `rows=${Number(rejectedRows.rows[0]?.n ?? -1)}`,
    );

    // ---- 1. valid delivery -------------------------------------------------
    const first = await post(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    });
    check('correctly-signed payload accepted 200', first.status === 200, `status=${first.status}`);
    check('first delivery reported as new', first.body.includes('"duplicate":false'), first.body);

    // ---- 2. duplicate delivery --------------------------------------------
    const second = await post(baseUrl, rawBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    });
    check('duplicate delivery still returns 200', second.status === 200, `status=${second.status}`);
    check('duplicate delivery reported as duplicate', second.body.includes('"duplicate":true'), second.body);

    const storedEvents = await db
      .select({ id: rawEvents.id, eventType: rawEvents.eventType })
      .from(rawEvents)
      .where(eq(rawEvents.providerEventId, eventId));
    check('exactly one raw_events row after two deliveries', storedEvents.length === 1, `rows=${storedEvents.length}`);
    check('raw_events row has the right event type', storedEvents[0]?.eventType === 'payment.failed');

    // ---- ingest ------------------------------------------------------------
    const summary = await runIngestPass(db);
    console.log(
      `[smoke] ingest: scanned=${summary.scanned} cases=${summary.casesCreated} ` +
        `signals=${summary.signalsRecorded} skipped=${summary.skipped} failed=${summary.failed}`,
    );
    check('ingest reported no failures', summary.failed === 0, `failed=${summary.failed}`);

    const cases = await db
      .select({
        id: recoveryCases.id,
        source: recoveryCases.source,
        amountPaise: recoveryCases.amountPaise,
        method: recoveryCases.method,
        issuer: recoveryCases.issuer,
        errorReason: recoveryCases.errorReason,
        status: recoveryCases.status,
        isSynthetic: recoveryCases.isSynthetic,
      })
      .from(recoveryCases)
      .where(eq(recoveryCases.externalRef, paymentId));

    check('exactly one recovery_case created', cases.length === 1, `cases=${cases.length}`);

    const created = cases[0];
    if (created) {
      check('case source is payment', created.source === 'payment', String(created.source));
      check('amount preserved as paise', created.amountPaise === 250_000, String(created.amountPaise));
      check('method normalized to card', created.method === 'card', String(created.method));
      check('issuer normalized to hdfc', created.issuer === 'hdfc', String(created.issuer));
      check(
        'error reason carried through',
        created.errorReason === 'insufficient_funds',
        String(created.errorReason),
      );
      check('status is open', created.status === 'open', String(created.status));
      check('marked live, not synthetic', created.isSynthetic === false, String(created.isSynthetic));
    }

    const processed = await db.execute<{ n: string | number }>(sql`
      SELECT COUNT(*) AS n FROM raw_events
      WHERE provider_event_id = ${eventId} AND processed_at IS NOT NULL
    `);
    check(
      'raw event stamped processed_at',
      Number(processed.rows[0]?.n ?? 0) === 1,
      `rows=${Number(processed.rows[0]?.n ?? 0)}`,
    );

    // ---- cleanup -----------------------------------------------------------
    if (process.env['SMOKE_KEEP'] !== '1') {
      await db.delete(recoveryCases).where(eq(recoveryCases.externalRef, paymentId));
      await db.delete(rawEvents).where(eq(rawEvents.providerEventId, eventId));
      console.log('\n[smoke] cleaned up the rows this run created');
    } else {
      console.log('\n[smoke] SMOKE_KEEP=1 — rows left in place for inspection');
    }
  } finally {
    await closeAllPools();
  }

  console.log(failures === 0 ? '\nALL WEBHOOK CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('[smoke] FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
