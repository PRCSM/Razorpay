import { getWebEnv } from '@reflow/core';
import { deriveProviderEventId, parseWebhookEnvelope, verifyRazorpaySignature } from '@reflow/core';
import { createServerlessDb, rawEvents } from '@reflow/db';
import { NextResponse } from 'next/server';

/**
 * Razorpay webhook receiver.
 *
 * Permanent target: https://reflow-puce.vercel.app/api/webhooks/razorpay
 *
 * Three things happen and nothing else: verify the HMAC, insert one row into
 * `raw_events`, return 200. The worker polls `raw_events` and does all the real
 * work — docs/ARCHITECTURE.md is explicit that this endpoint never processes
 * inline, because a slow handler gets retried by the provider and retried
 * handlers cause duplicate work.
 *
 * Idempotency is enforced by the UNIQUE constraint on `provider_event_id`. A
 * duplicate delivery is a no-op that still returns 200, so Razorpay stops
 * retrying instead of escalating.
 */

/** bcrypt-free, but `node:crypto` and the pg driver still need the Node runtime. */
export const runtime = 'nodejs';

/** Never cache or prerender a webhook receiver. */
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_ID_HEADER = 'x-razorpay-event-id';

export async function POST(request: Request): Promise<NextResponse> {
  // The signature is computed over the EXACT bytes sent. Parsing to JSON and
  // re-serialising changes key order and whitespace and breaks verification, so
  // the body is read as text and only parsed after the signature is confirmed.
  const rawBody = await request.text();

  const env = getWebEnv();

  const verification = verifyRazorpaySignature({
    rawBody,
    signatureHeader: request.headers.get(SIGNATURE_HEADER),
    secret: env.RAZORPAY_WEBHOOK_SECRET,
  });

  if (!verification.ok) {
    // Deliberately terse. A verbose rejection tells an attacker which part of
    // their forgery was wrong.
    console.warn(`[webhook] rejected: ${verification.reason}`);
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  const parsed = parseWebhookEnvelope(rawBody);
  if (!parsed.ok) {
    // Signature was valid, so this really did come from Razorpay — the shape is
    // just unfamiliar. Reject with 400 so the delivery is visible in their
    // dashboard rather than silently swallowed.
    console.warn(`[webhook] signed but unparseable: ${parsed.reason}`);
    return NextResponse.json({ error: 'malformed payload' }, { status: 400 });
  }

  const envelope = parsed.envelope;
  const providerEventId = deriveProviderEventId({
    eventIdHeader: request.headers.get(EVENT_ID_HEADER),
    rawBody,
  });

  try {
    const db = createServerlessDb(env.DATABASE_URL);

    // ON CONFLICT DO NOTHING against the UNIQUE index. `inserted` is empty when
    // this event id has already been stored, which is exactly how a retry
    // becomes a no-op without a read-then-write race.
    const inserted = await db
      .insert(rawEvents)
      .values({
        providerEventId,
        eventType: envelope.event,
        payload: envelope,
      })
      .onConflictDoNothing({ target: rawEvents.providerEventId })
      .returning({ id: rawEvents.id });

    const duplicate = inserted.length === 0;
    console.log(
      `[webhook] ${envelope.event} ${providerEventId} ${duplicate ? 'duplicate (no-op)' : 'stored'}`,
    );

    return NextResponse.json({ received: true, duplicate }, { status: 200 });
  } catch (error) {
    // A 500 makes Razorpay retry, which is what we want: the event is not stored,
    // so redelivery is the correct recovery. Never return 200 on a failed write.
    console.error('[webhook] failed to store event', error);
    return NextResponse.json({ error: 'storage failure' }, { status: 500 });
  }
}

/** Razorpay only POSTs. A GET is almost always someone checking the URL by hand. */
export function GET(): NextResponse {
  return NextResponse.json(
    { error: 'method not allowed', hint: 'Razorpay webhooks are delivered by POST' },
    { status: 405 },
  );
}
