/**
 * The Razorpay webhook envelope.
 *
 * Validated at the boundary, but deliberately PERMISSIVE about `payload`. Two
 * reasons: docs/DATABASE_DESIGN.md requires we store provider payloads raw and
 * never discard what was sent, and a schema tight enough to reject an unfamiliar
 * entity shape would drop deliveries that the normalizer is explicitly required
 * to handle by returning nulls.
 *
 * So the envelope invariants are enforced — is this an event, which event, when —
 * and entity extraction is left to `../normalize`, which never throws.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const webhookEnvelopeSchema = z
  .object({
    /** Always the literal "event" for a webhook delivery. */
    entity: z.string().min(1).optional(),
    account_id: z.string().min(1).optional(),
    /** e.g. "payment.failed" */
    event: z.string().min(1, 'event type is required'),
    /** Which entities the payload contains, e.g. ["payment"]. */
    contains: z.array(z.string()).optional(),
    /** Entity-keyed: { payment: { entity: {...} } }. Shape varies by event. */
    payload: z.record(z.string(), z.unknown()),
    /** Unix seconds. */
    created_at: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: WebhookEnvelope }
  | { readonly ok: false; readonly reason: string };

/** Parse raw JSON text into a validated envelope. Never throws. */
export function parseWebhookEnvelope(rawBody: string): EnvelopeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'body is not valid JSON' };
  }

  const result = webhookEnvelopeSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: `envelope failed validation — ${detail}` };
  }
  return { ok: true, envelope: result.data };
}

/**
 * The idempotency key for `raw_events.provider_event_id`.
 *
 * Razorpay sends `x-razorpay-event-id`, which is the canonical value and is used
 * whenever present. When it is absent — simulated checkout events, hand-crafted
 * test payloads — a deterministic digest of the exact body is used instead, so
 * replaying the same delivery still collapses to one row.
 *
 * This is what stops a retried `payment.failed` becoming two recovery cases and
 * contacting the customer twice.
 */
export function deriveProviderEventId(args: {
  readonly eventIdHeader: string | null | undefined;
  readonly rawBody: string;
}): string {
  const header = args.eventIdHeader?.trim();
  if (header) return header;

  const digest = createHash('sha256').update(args.rawBody, 'utf8').digest('hex');
  return `derived_${digest.slice(0, 40)}`;
}
