import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeRazorpaySignature, verifyRazorpaySignature } from './signature';

/**
 * The webhook is the only unauthenticated, internet-facing surface in the system.
 * These tests exist because a signature check that silently accepts everything
 * looks exactly like one that works.
 *
 * The secret below is a fixture, not a real credential.
 */
const SECRET = 'test_webhook_secret_0123456789abcdef';
const BODY = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: {} } } });

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('computeRazorpaySignature', () => {
  it('produces a 64-character hex sha256 digest', () => {
    expect(computeRazorpaySignature(BODY, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches an independently computed HMAC', () => {
    expect(computeRazorpaySignature(BODY, SECRET)).toBe(sign(BODY));
  });

  it('changes when a single byte of the body changes', () => {
    expect(computeRazorpaySignature(BODY, SECRET)).not.toBe(
      computeRazorpaySignature(`${BODY} `, SECRET),
    );
  });

  it('changes when the secret changes', () => {
    expect(computeRazorpaySignature(BODY, SECRET)).not.toBe(
      computeRazorpaySignature(BODY, `${SECRET}x`),
    );
  });
});

describe('verifyRazorpaySignature — valid', () => {
  it('accepts a correctly signed body', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: sign(BODY),
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an uppercase hex signature', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: sign(BODY).toUpperCase(),
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a signature with surrounding whitespace', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: `  ${sign(BODY)}  `,
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty body that is correctly signed', () => {
    const result = verifyRazorpaySignature({
      rawBody: '',
      signatureHeader: sign(''),
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });
});

describe('verifyRazorpaySignature — invalid', () => {
  it('rejects a signature made with the wrong secret', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: sign(BODY, 'the_wrong_secret'),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a valid signature over a DIFFERENT body — the replay case', () => {
    const result = verifyRazorpaySignature({
      rawBody: JSON.stringify({ event: 'payment.captured' }),
      signatureHeader: sign(BODY),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a tampered body, even by one trailing space', () => {
    const result = verifyRazorpaySignature({
      rawBody: `${BODY} `,
      signatureHeader: sign(BODY),
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a flipped hex character', () => {
    const good = sign(BODY);
    const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: flipped,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('verifyRazorpaySignature — missing or malformed', () => {
  it('rejects a missing header (null)', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: null,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects an undefined header', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: undefined,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects an empty or whitespace-only header', () => {
    for (const header of ['', '   ']) {
      expect(
        verifyRazorpaySignature({ rawBody: BODY, signatureHeader: header, secret: SECRET }),
      ).toEqual({ ok: false, reason: 'missing_signature' });
    }
  });

  it('rejects a signature of the wrong length', () => {
    for (const header of ['abc123', sign(BODY).slice(0, 63), `${sign(BODY)}ff`]) {
      expect(
        verifyRazorpaySignature({ rawBody: BODY, signatureHeader: header, secret: SECRET }),
      ).toEqual({ ok: false, reason: 'malformed_signature' });
    }
  });

  it('rejects a non-hex signature of the right length', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: 'z'.repeat(64),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('refuses to verify when the secret is absent — never silently passes', () => {
    const result = verifyRazorpaySignature({
      rawBody: BODY,
      signatureHeader: sign(BODY),
      secret: '',
    });
    expect(result).toEqual({ ok: false, reason: 'missing_secret' });
  });
});
