/**
 * Razorpay webhook signature verification.
 *
 * Pure and deterministic: the same body, header, and secret always produce the
 * same verdict, and nothing here touches the network, the database, the
 * filesystem, or the clock. `node:crypto` is a pure computation — it is not I/O —
 * which is why this belongs in core rather than in the route handler. The route
 * gets to be thin, and the trust boundary gets to be unit-tested.
 *
 * docs/ARCHITECTURE.md: "Verify, store, return 200 fast."
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digests are always 64 characters. */
const HEX_DIGEST_LENGTH = 64;

export type SignatureFailureReason =
  | 'missing_secret'
  | 'missing_signature'
  | 'malformed_signature'
  | 'signature_mismatch';

export type SignatureVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SignatureFailureReason };

/**
 * HMAC-SHA256 of the raw request body, hex encoded.
 *
 * MUST be computed over the exact bytes Razorpay sent. Re-serialising parsed
 * JSON changes key order and whitespace and produces a different digest, so the
 * caller reads the body as text and never as JSON first.
 */
export function computeRazorpaySignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verify the `x-razorpay-signature` header against the raw body.
 *
 * Comparison is timing-safe. A length mismatch short-circuits, which is safe:
 * the digest length is a public constant, so nothing about the secret leaks.
 */
export function verifyRazorpaySignature(args: {
  readonly rawBody: string;
  readonly signatureHeader: string | null | undefined;
  readonly secret: string;
}): SignatureVerification {
  const { rawBody, signatureHeader, secret } = args;

  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, reason: 'missing_secret' };
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.trim() === '') {
    return { ok: false, reason: 'missing_signature' };
  }

  const provided = signatureHeader.trim().toLowerCase();
  if (provided.length !== HEX_DIGEST_LENGTH || !/^[0-9a-f]+$/.test(provided)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const expected = computeRazorpaySignature(rawBody, secret);

  const providedBytes = Buffer.from(provided, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (providedBytes.length !== expectedBytes.length) {
    return { ok: false, reason: 'malformed_signature' };
  }

  return timingSafeEqual(providedBytes, expectedBytes)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}
