/**
 * Raw provider payload → a canonical `RecoveryCase` draft.
 *
 * Four sources collapse into one shape here, which is what lets everything
 * downstream be source-agnostic (docs/ARCHITECTURE.md, step 2):
 *
 *   payment      ← payment.failed
 *   mandate      ← subscription.halted | subscription.pending
 *   checkout     ← checkout.abandoned  (simulated; Razorpay has no such event)
 *   receivable   ← invoice.expired
 *
 * PURE. No I/O, no clock — `receivedAt` is passed in. `node:crypto` is used only
 * to derive an opaque customer token, which is a deterministic computation.
 *
 * Nothing here throws. An unrecognised payload yields a draft full of nulls plus
 * warnings, so the case reaches diagnosis and the exception list instead of
 * crash-looping the ingest worker (docs/INSTRUCTIONS.md hard rule 6).
 */

import { createHash } from 'node:crypto';
import { CHECKOUT_ABANDONED_EVENT } from '../webhook/events';
import type { CaseSource, PaymentMethod } from '../types/enums';
import {
  readFirstString,
  readNonNegativeInteger,
  readObject,
  readPath,
  readProp,
  readString,
} from './read';

/**
 * The columns of `recovery_cases` that ingest supplies. `id`, `status`,
 * `attempt_count`, and the diagnosis columns come from database defaults or from
 * later phases.
 */
export interface RecoveryCaseDraft {
  readonly source: CaseSource;
  readonly externalRef: string | null;
  /** Integer paise. Razorpay already sends paise, so no conversion is applied. */
  readonly amountPaise: number;
  readonly currency: string;
  /** Opaque. Never a real name, email, or phone. */
  readonly customerRef: string | null;
  readonly method: PaymentMethod | null;
  readonly issuer: string | null;
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly errorReason: string | null;
  readonly openedAt: Date;
}

export type NormalizeResult =
  | {
      readonly ok: true;
      readonly draft: RecoveryCaseDraft;
      /** Non-fatal parse problems. Persisted by the caller, never dropped. */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const DEFAULT_CURRENCY = 'INR';

/** Razorpay method string → our vocabulary. Unknown values become null. */
const METHOD_MAP: Readonly<Record<string, PaymentMethod>> = {
  card: 'card',
  upi: 'upi',
  netbanking: 'netbanking',
  nb: 'netbanking',
  wallet: 'wallet',
  emandate: 'emandate',
  nach: 'emandate',
  upi_autopay: 'emandate',
  // `emi` and `paylater` settle on a card rail; treating them as card keeps the
  // issuer bucket meaningful for retry timing rather than discarding the signal.
  emi: 'card',
  cardless_emi: 'card',
};

function normalizeMethod(value: unknown): PaymentMethod | null {
  const raw = readString(value);
  if (raw === null) return null;
  return METHOD_MAP[raw.toLowerCase()] ?? null;
}

/**
 * A stable, opaque customer token.
 *
 * The contact cap in policy.yaml counts messages per customer ACROSS cases, so
 * the same customer must produce the same token every time. When the provider
 * gives an id we use it directly. When it only gives an email or phone we hash
 * it — the system stores no PII (docs/ARCHITECTURE.md, "PII: None"), but it still
 * needs to recognise a repeat customer.
 */
function deriveCustomerRef(entity: unknown): string | null {
  const explicit = readFirstString(entity, ['customer_id', 'customer_ref']);
  if (explicit !== null) return explicit;

  const notes = readProp(entity, 'notes');
  const fromNotes = readFirstString(notes, ['customer_ref', 'customer_id']);
  if (fromNotes !== null) return fromNotes;

  const nested = readFirstString(readProp(entity, 'customer'), ['id', 'customer_id']);
  if (nested !== null) return nested;

  // Last resort: hash a contact identifier so it is never stored in the clear.
  const identifier = readFirstString(entity, ['email', 'contact', 'vpa']);
  if (identifier === null) return null;

  const digest = createHash('sha256')
    .update(`reflow:customer:${identifier.toLowerCase()}`, 'utf8')
    .digest('hex');
  return `cust_${digest.slice(0, 16)}`;
}

/**
 * The bank or PSP handle, used as a bandit bucket key.
 * For UPI the handle after `@` is the issuer, e.g. `user@okhdfcbank` → `okhdfcbank`.
 */
function deriveIssuer(entity: unknown, method: PaymentMethod | null): string | null {
  const direct = readFirstString(entity, ['bank', 'issuer', 'wallet']);
  if (direct !== null) return direct.toLowerCase();

  const acquirer = readFirstString(readProp(entity, 'acquirer_data'), [
    'bank',
    'issuer',
    'acquirer',
  ]);
  if (acquirer !== null) return acquirer.toLowerCase();

  if (method === 'upi' || method === 'emandate') {
    const vpa = readString(readProp(entity, 'vpa'));
    const handle = vpa?.split('@')[1];
    if (handle) return handle.toLowerCase();
  }

  const cardIssuer = readFirstString(readProp(entity, 'card'), ['issuer', 'network']);
  if (cardIssuer !== null) return cardIssuer.toLowerCase();

  return null;
}

interface ErrorFields {
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly errorReason: string | null;
}

function readErrorFields(entity: unknown): ErrorFields {
  return {
    errorCode: readFirstString(entity, ['error_code', 'code']),
    errorSource: readFirstString(entity, ['error_source', 'source']),
    errorStep: readFirstString(entity, ['error_step', 'step']),
    errorReason: readFirstString(entity, ['error_reason', 'error_description', 'description']),
  };
}

const NO_ERROR: ErrorFields = {
  errorCode: null,
  errorSource: null,
  errorStep: null,
  errorReason: null,
};

/**
 * Find the entity container.
 *
 * `raw_events.payload` holds the COMPLETE Razorpay envelope — we never discard
 * what the provider sent — so the entities live one level down, under
 * `envelope.payload`. Callers that already hold just the inner payload (tests,
 * the synthetic generator) pass that directly.
 *
 * Both shapes are accepted: if the input has an object-valued `payload` key, that
 * is the container; otherwise the input itself is.
 */
function resolveContainer(input: unknown): unknown {
  const nested = readObject(readProp(input, 'payload'));
  return nested ?? input;
}

/** `<container>.<key>.entity`, falling back to `<container>.<key>` when flattened. */
function extractEntity(input: unknown, key: string): Record<string, unknown> | null {
  const container = resolveContainer(input);
  const withEntity = readObject(readPath(container, [key, 'entity']));
  if (withEntity) return withEntity;
  return readObject(readProp(container, key));
}

function readCurrency(entity: unknown, warnings: string[]): string {
  const currency = readString(readProp(entity, 'currency'));
  if (currency === null) {
    warnings.push(`currency missing; defaulted to ${DEFAULT_CURRENCY}`);
    return DEFAULT_CURRENCY;
  }
  return currency.toUpperCase();
}

/**
 * Read a money amount in paise.
 *
 * `recovery_cases.amount_paise` is NOT NULL, so an unreadable amount becomes 0
 * with a warning rather than a rejected delivery. A zero-amount case is visibly
 * wrong and lands in the exception list, which is the honest outcome — dropping
 * the event would hide it.
 */
function readAmountPaise(
  entity: unknown,
  keys: readonly string[],
  warnings: string[],
  label: string,
): number {
  for (const key of keys) {
    const amount = readNonNegativeInteger(readProp(entity, key));
    if (amount !== null) return amount;
  }
  warnings.push(`${label}: no readable integer amount in [${keys.join(', ')}]; defaulted to 0`);
  return 0;
}

// ---------------------------------------------------------------------------
// Per-source normalizers
// ---------------------------------------------------------------------------

function normalizePayment(payload: unknown, receivedAt: Date): NormalizeResult {
  const warnings: string[] = [];
  const entity = extractEntity(payload, 'payment');

  if (!entity) {
    warnings.push('payload.payment.entity missing; emitting a null-filled payment case');
  }

  const method = normalizeMethod(readProp(entity, 'method'));
  if (entity && method === null) {
    warnings.push('payment method unrecognised or absent');
  }

  const errors = readErrorFields(entity);

  return {
    ok: true,
    draft: {
      source: 'payment',
      externalRef: readFirstString(entity, ['id', 'payment_id']),
      amountPaise: readAmountPaise(entity, ['amount'], warnings, 'payment'),
      currency: readCurrency(entity, warnings),
      customerRef: deriveCustomerRef(entity),
      method,
      issuer: deriveIssuer(entity, method),
      ...errors,
      openedAt: receivedAt,
    },
    warnings,
  };
}

/**
 * Mandates. A halted or pending subscription often arrives with the failed
 * payment attached, so the error detail and the amount are read from that
 * payment entity when the subscription itself does not carry them.
 */
function normalizeMandate(payload: unknown, receivedAt: Date): NormalizeResult {
  const warnings: string[] = [];
  const subscription = extractEntity(payload, 'subscription');
  const payment = extractEntity(payload, 'payment');

  if (!subscription) {
    warnings.push('payload.subscription.entity missing; emitting a null-filled mandate case');
  }

  // A mandate debit is emandate unless the attached payment says otherwise.
  const method = normalizeMethod(readProp(payment, 'method')) ?? 'emandate';

  const amountPaise = payment
    ? readAmountPaise(payment, ['amount'], warnings, 'mandate payment')
    : readAmountPaise(subscription, ['amount', 'total_amount'], warnings, 'mandate subscription');

  const errors = payment ? readErrorFields(payment) : readErrorFields(subscription);

  const currencySource = payment ?? subscription;

  return {
    ok: true,
    draft: {
      source: 'mandate',
      externalRef: readFirstString(subscription, ['id', 'subscription_id']),
      amountPaise,
      currency: readCurrency(currencySource, warnings),
      customerRef: deriveCustomerRef(subscription) ?? deriveCustomerRef(payment),
      method,
      issuer: deriveIssuer(payment, method) ?? deriveIssuer(subscription, method),
      ...errors,
      openedAt: receivedAt,
    },
    warnings,
  };
}

/**
 * Checkout abandonment. Simulated — Razorpay emits no "customer left" event —
 * so this payload shape is ours. Accepts a `checkout` or `order` entity.
 */
function normalizeCheckout(payload: unknown, receivedAt: Date): NormalizeResult {
  const warnings: string[] = [];
  const entity = extractEntity(payload, 'checkout') ?? extractEntity(payload, 'order');

  if (!entity) {
    warnings.push('payload.checkout.entity missing; emitting a null-filled checkout case');
  }

  const method = normalizeMethod(readProp(entity, 'method'));

  return {
    ok: true,
    draft: {
      source: 'checkout',
      externalRef: readFirstString(entity, ['id', 'order_id', 'checkout_id']),
      // amount_due first: a partially-paid order only risks the remainder.
      amountPaise: readAmountPaise(entity, ['amount_due', 'amount'], warnings, 'checkout'),
      currency: readCurrency(entity, warnings),
      customerRef: deriveCustomerRef(entity),
      method,
      issuer: deriveIssuer(entity, method),
      // Abandonment has no provider error. The cause is behavioural, and
      // diagnosis assigns it in Run 3.
      ...NO_ERROR,
      errorReason: readString(readProp(entity, 'abandon_reason')),
      openedAt: receivedAt,
    },
    warnings,
  };
}

/** B2B receivables. An expired invoice is money owed and unpaid. */
function normalizeReceivable(payload: unknown, receivedAt: Date): NormalizeResult {
  const warnings: string[] = [];
  const entity = extractEntity(payload, 'invoice');

  if (!entity) {
    warnings.push('payload.invoice.entity missing; emitting a null-filled receivable case');
  }

  const method = normalizeMethod(readProp(entity, 'method'));

  return {
    ok: true,
    draft: {
      source: 'receivable',
      externalRef: readFirstString(entity, ['id', 'invoice_id']),
      // amount_due is the outstanding balance; `amount` is the invoice total.
      amountPaise: readAmountPaise(entity, ['amount_due', 'amount'], warnings, 'receivable'),
      currency: readCurrency(entity, warnings),
      customerRef: deriveCustomerRef(entity),
      method,
      issuer: deriveIssuer(entity, method),
      ...NO_ERROR,
      errorReason: readFirstString(entity, ['status', 'description']),
      openedAt: receivedAt,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Normalize one raw event.
 *
 * `receivedAt` is supplied by the caller — core never reads the clock.
 * Returns `ok: false` only for an event type that opens no case; every
 * case-opening event yields a draft, however malformed its payload.
 */
export function normalizeEvent(args: {
  readonly eventType: string;
  readonly payload: unknown;
  readonly receivedAt: Date;
}): NormalizeResult {
  const { eventType, payload, receivedAt } = args;

  switch (eventType) {
    case 'payment.failed':
      return normalizePayment(payload, receivedAt);

    case 'subscription.halted':
    case 'subscription.pending':
      return normalizeMandate(payload, receivedAt);

    case CHECKOUT_ABANDONED_EVENT:
      return normalizeCheckout(payload, receivedAt);

    case 'invoice.expired':
      return normalizeReceivable(payload, receivedAt);

    default:
      return {
        ok: false,
        reason: `event type "${eventType}" does not open a recovery case`,
      };
  }
}

export { readObject, readString, readNonNegativeInteger, readPath, readProp } from './read';

export {
  DOWNTIME_EVENT_TYPES,
  isDowntimeEvent,
  normalizeDowntimeEvent,
  type DowntimeDraft,
  type DowntimeEventType,
  type DowntimeNormalizeResult,
} from './downtime';
