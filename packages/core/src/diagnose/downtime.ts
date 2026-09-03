/**
 * Issuer downtime matching.
 *
 * Razorpay reports issuer downtime directly through `payment.downtime.started` /
 * `.updated` / `.resolved`. When a failure lands inside an ACTIVE window for the
 * same issuer and rail, `issuer_down` is an observed fact rather than an
 * inference from an error code — so it is recorded at confidence 1.0 with
 * `cause_by = 'downtime_signal'`.
 *
 * This does NOT replace the inference path. The synthetic lane has no downtime
 * events at all, so `payment.issuer_down` in the rule table must keep working
 * independently, and both paths are tested. See ADR-029.
 *
 * PURE. Time is a parameter; nothing here reads the clock.
 */

import type { PaymentMethod } from '../types/enums';

/** A downtime window as stored. `resolvedAt` null means still ongoing. */
export interface DowntimeWindow {
  readonly id?: string;
  /** Bank or PSP handle, lowercase. null means the outage was not issuer-scoped. */
  readonly issuer: string | null;
  /** Affected rail. null means all rails. */
  readonly method: PaymentMethod | null;
  readonly startedAt: Date;
  /** null = unresolved, i.e. still down. */
  readonly resolvedAt: Date | null;
  /** Razorpay's severity, when supplied: 'low' | 'medium' | 'high'. */
  readonly severity: string | null;
}

/** What a failure needs to be checked against the windows. */
export interface DowntimeQuery {
  readonly issuer: string | null;
  readonly method: PaymentMethod | null;
  /** When the failure happened. Passed in — core never reads the clock. */
  readonly at: Date;
}

function normalizeIssuer(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Is `at` inside this window?
 *
 * Inclusive at both ends. An unresolved window extends indefinitely forward,
 * which is the correct reading of "started and not yet resolved" — but it means a
 * stale unresolved window would swallow every later failure, so the store closes
 * windows on `payment.downtime.resolved` and the worker logs any window left open
 * for an implausible length of time.
 */
export function windowCoversInstant(window: DowntimeWindow, at: Date): boolean {
  const t = at.getTime();
  if (t < window.startedAt.getTime()) return false;
  if (window.resolvedAt === null) return true;
  return t <= window.resolvedAt.getTime();
}

/**
 * Does this window apply to the queried issuer and rail?
 * A null issuer or method on the WINDOW is a wildcard — Razorpay sometimes reports
 * a platform-wide or method-wide outage with no single issuer named.
 */
export function windowAppliesTo(window: DowntimeWindow, query: DowntimeQuery): boolean {
  if (window.issuer !== null) {
    const queryIssuer = normalizeIssuer(query.issuer);
    if (queryIssuer === null) return false;
    if (normalizeIssuer(window.issuer) !== queryIssuer) return false;
  }

  if (window.method !== null) {
    if (query.method === null) return false;
    if (window.method !== query.method) return false;
  }

  return true;
}

/**
 * The most specific active window covering this failure, or null.
 *
 * Specificity ordering matters: an issuer+method window is stronger evidence than
 * a platform-wide one, so it is preferred when several match.
 */
export function findActiveDowntime(
  query: DowntimeQuery,
  windows: readonly DowntimeWindow[],
): DowntimeWindow | null {
  const matches = windows.filter(
    (w) => windowAppliesTo(w, query) && windowCoversInstant(w, query.at),
  );
  if (matches.length === 0) return null;

  const specificity = (w: DowntimeWindow): number =>
    (w.issuer !== null ? 2 : 0) + (w.method !== null ? 1 : 0);

  let best = matches[0];
  if (best === undefined) return null;
  for (const candidate of matches.slice(1)) {
    if (specificity(candidate) > specificity(best)) best = candidate;
    // Tie-break on the later start: the most recent outage is the live one.
    else if (
      specificity(candidate) === specificity(best) &&
      candidate.startedAt.getTime() > best.startedAt.getTime()
    ) {
      best = candidate;
    }
  }
  return best;
}
