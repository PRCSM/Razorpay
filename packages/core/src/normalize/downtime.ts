/**
 * Normalize `payment.downtime.*` into a downtime window.
 *
 * Razorpay's downtime entity looks roughly like:
 *
 *   { id, entity: "payment.downtime", method: "upi", begin: <unix>, end: <unix|null>,
 *     status: "started" | "resolved", scheduled: false, severity: "high",
 *     instrument: { bank: "HDFC" } | { vpa_handle: "okhdfcbank" } | { issuer: "SBIN" } }
 *
 * The issuer hides in `instrument` under a different key per rail, which is the
 * only genuinely fiddly part.
 *
 * PURE — no clock, no I/O. Never throws; an unreadable payload returns a reason.
 */

import type { PaymentMethod } from '../types/enums';
import type { DowntimeWindow } from '../diagnose/downtime';
import { readFirstString, readObject, readProp, readString, readUnixSeconds } from './read';

/** The three downtime events. */
export const DOWNTIME_EVENT_TYPES = [
  'payment.downtime.started',
  'payment.downtime.updated',
  'payment.downtime.resolved',
] as const;

export type DowntimeEventType = (typeof DOWNTIME_EVENT_TYPES)[number];

export function isDowntimeEvent(eventType: string): eventType is DowntimeEventType {
  return (DOWNTIME_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** A window plus the provider id, so repeat deliveries update rather than duplicate. */
export interface DowntimeDraft extends DowntimeWindow {
  /** Razorpay's downtime id — the upsert key. */
  readonly providerDowntimeId: string;
  /** Razorpay's own status string, kept verbatim. */
  readonly status: string | null;
  /** True for planned maintenance, which is still a real outage. */
  readonly scheduled: boolean;
}

export type DowntimeNormalizeResult =
  | { readonly ok: true; readonly draft: DowntimeDraft; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const METHOD_MAP: Readonly<Record<string, PaymentMethod>> = {
  card: 'card',
  upi: 'upi',
  netbanking: 'netbanking',
  nb: 'netbanking',
  wallet: 'wallet',
  emandate: 'emandate',
  nach: 'emandate',
  upi_autopay: 'emandate',
};

/**
 * The affected issuer.
 *
 * Razorpay names it differently per rail — `bank` for cards and netbanking,
 * `vpa_handle` for UPI, `issuer` for some card payloads, `wallet` for wallets.
 * A UPI handle like `okhdfcbank` is kept as-is, matching how the payment
 * normalizer derives an issuer from a VPA, so the two agree on the bucket key.
 */
function extractIssuer(instrument: unknown, topLevel: unknown): string | null {
  const fromInstrument = readFirstString(instrument, [
    'bank',
    'vpa_handle',
    'issuer',
    'wallet',
    'psp',
  ]);
  if (fromInstrument !== null) return fromInstrument.toLowerCase();

  const fromTop = readFirstString(topLevel, ['bank', 'issuer', 'wallet']);
  return fromTop === null ? null : fromTop.toLowerCase();
}

/** `payload.payment.downtime.entity`, with fallbacks for flatter shapes. */
function extractDowntimeEntity(input: unknown): Record<string, unknown> | null {
  const container = readObject(readProp(input, 'payload')) ?? input;

  const nested = readObject(readProp(readProp(container, 'payment'), 'downtime'));
  const nestedEntity = readObject(readProp(nested, 'entity')) ?? nested;
  if (nestedEntity) return nestedEntity;

  const direct = readObject(readProp(container, 'payment.downtime'));
  const directEntity = readObject(readProp(direct, 'entity')) ?? direct;
  if (directEntity) return directEntity;

  const flat = readObject(readProp(container, 'downtime'));
  return readObject(readProp(flat, 'entity')) ?? flat;
}

/**
 * Normalize one downtime event.
 *
 * `resolvedAt` is set when the payload carries an `end`, or when the event is
 * `.resolved`. A resolved event with no `end` falls back to the envelope's
 * `created_at`, because a resolution with no timestamp would otherwise leave the
 * window open forever and swallow every later failure.
 */
export function normalizeDowntimeEvent(args: {
  readonly eventType: string;
  readonly payload: unknown;
  readonly receivedAt: Date;
}): DowntimeNormalizeResult {
  const { eventType, payload, receivedAt } = args;

  if (!isDowntimeEvent(eventType)) {
    return { ok: false, reason: `event type "${eventType}" is not a downtime event` };
  }

  const entity = extractDowntimeEntity(payload);
  const warnings: string[] = [];

  const providerDowntimeId = readFirstString(entity, ['id', 'downtime_id']);
  if (providerDowntimeId === null) {
    // Without an id there is no upsert key, so `.updated` and `.resolved` could
    // not be matched to the window they modify. Refusing is the honest outcome.
    return { ok: false, reason: 'downtime payload has no id — cannot key the window' };
  }

  const rawMethod = readString(readProp(entity, 'method'));
  const method = rawMethod === null ? null : (METHOD_MAP[rawMethod.toLowerCase()] ?? null);
  if (rawMethod !== null && method === null) {
    warnings.push(`unrecognised downtime method "${rawMethod}"; treated as all rails`);
  }

  const instrument = readProp(entity, 'instrument');
  const issuer = extractIssuer(instrument, entity);
  if (issuer === null) {
    warnings.push('no issuer in downtime payload; treated as a platform-wide outage');
  }

  const startedAt = readUnixSeconds(readProp(entity, 'begin')) ?? receivedAt;
  if (readUnixSeconds(readProp(entity, 'begin')) === null) {
    warnings.push('no begin timestamp; used the delivery time');
  }

  const explicitEnd = readUnixSeconds(readProp(entity, 'end'));
  const isResolvedEvent = eventType === 'payment.downtime.resolved';

  let resolvedAt: Date | null = explicitEnd;
  if (resolvedAt === null && isResolvedEvent) {
    resolvedAt = receivedAt;
    warnings.push('resolved event carried no end timestamp; used the delivery time');
  }

  const status = readString(readProp(entity, 'status'));
  const scheduled = readProp(entity, 'scheduled') === true;
  const severity = readString(readProp(entity, 'severity'));

  return {
    ok: true,
    draft: {
      providerDowntimeId,
      issuer,
      method,
      startedAt,
      resolvedAt,
      severity,
      status,
      scheduled,
    },
    warnings,
  };
}
