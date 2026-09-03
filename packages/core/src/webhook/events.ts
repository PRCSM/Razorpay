/**
 * The webhook event vocabulary.
 *
 * `raw_events` stores EVERY delivery regardless of type — docs/DATABASE_DESIGN.md
 * is explicit that we never discard what the provider sent. This list is about
 * which events the ingest worker turns into a `recovery_case`, not about which
 * ones we accept.
 */

/** The nine Razorpay events registered in the dashboard. */
export const SUBSCRIBED_EVENT_TYPES = [
  'payment.failed',
  'payment.captured',
  'order.paid',
  'payment_link.paid',
  'subscription.halted',
  'subscription.pending',
  'subscription.charged',
  'invoice.paid',
  'invoice.expired',
] as const;

export type SubscribedEventType = (typeof SUBSCRIBED_EVENT_TYPES)[number];

/**
 * Checkout abandonment has no Razorpay webhook — there is no event for "customer
 * left". It is simulated, and carries its own event type so the live and
 * synthetic lanes stay distinguishable in `raw_events.event_type`.
 */
export const CHECKOUT_ABANDONED_EVENT = 'checkout.abandoned' as const;

/**
 * Events that OPEN a recovery case — something is at risk.
 * The rest are recovery signals, consumed by outcome attribution in Run 5.
 */
export const CASE_OPENING_EVENT_TYPES = [
  'payment.failed',
  'subscription.halted',
  'subscription.pending',
  'invoice.expired',
  CHECKOUT_ABANDONED_EVENT,
] as const;

export type CaseOpeningEventType = (typeof CASE_OPENING_EVENT_TYPES)[number];

/**
 * Events that signal money arrived. Stored now, attributed to actions in Run 5
 * inside the `attribution.window_hours` window from policy.yaml.
 */
export const RECOVERY_SIGNAL_EVENT_TYPES = [
  'payment.captured',
  'order.paid',
  'payment_link.paid',
  'subscription.charged',
  'invoice.paid',
] as const;

export type RecoverySignalEventType = (typeof RECOVERY_SIGNAL_EVENT_TYPES)[number];

export function isCaseOpeningEvent(eventType: string): eventType is CaseOpeningEventType {
  return (CASE_OPENING_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function isRecoverySignalEvent(eventType: string): eventType is RecoverySignalEventType {
  return (RECOVERY_SIGNAL_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function isSubscribedEvent(eventType: string): eventType is SubscribedEventType {
  return (SUBSCRIBED_EVENT_TYPES as readonly string[]).includes(eventType);
}
