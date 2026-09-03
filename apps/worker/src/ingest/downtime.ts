/**
 * Persist downtime windows from `payment.downtime.*` events.
 *
 * Upserts on `provider_downtime_id`, so `.started` creates the window and
 * `.updated` / `.resolved` modify that same row. Without the upsert, one outage
 * delivered three times would become three windows and the same failure would be
 * matched three ways.
 */

import { normalizeDowntimeEvent } from '@reflow/core';
import { downtimeWindows, type PooledDb } from '@reflow/db';
import { and, asc, gte, isNull, or, sql } from 'drizzle-orm';
import type { DowntimeWindow } from '@reflow/core';

export interface DowntimeUpsertResult {
  readonly ok: boolean;
  readonly providerDowntimeId: string | null;
  readonly created: boolean;
  readonly warnings: readonly string[];
  readonly reason: string | null;
}

/** Normalize one downtime event and upsert the window. */
export async function upsertDowntimeFromEvent(
  db: PooledDb,
  args: { eventType: string; payload: unknown; receivedAt: Date },
): Promise<DowntimeUpsertResult> {
  const normalized = normalizeDowntimeEvent(args);

  if (!normalized.ok) {
    return {
      ok: false,
      providerDowntimeId: null,
      created: false,
      warnings: [],
      reason: normalized.reason,
    };
  }

  const draft = normalized.draft;

  const inserted = await db
    .insert(downtimeWindows)
    .values({
      providerDowntimeId: draft.providerDowntimeId,
      issuer: draft.issuer,
      method: draft.method,
      startedAt: draft.startedAt,
      resolvedAt: draft.resolvedAt,
      severity: draft.severity,
      status: draft.status,
      scheduled: draft.scheduled,
    })
    .onConflictDoUpdate({
      target: downtimeWindows.providerDowntimeId,
      set: {
        // `.resolved` must be able to close the window, and `.updated` may revise
        // severity or the end time. `started_at` and the issuer are not revised:
        // when an outage began does not change.
        resolvedAt: draft.resolvedAt,
        severity: draft.severity,
        status: draft.status,
        method: draft.method,
        updatedAt: new Date(),
      },
    })
    .returning({ id: downtimeWindows.id });

  return {
    ok: true,
    providerDowntimeId: draft.providerDowntimeId,
    created: inserted.length > 0,
    warnings: normalized.warnings,
    reason: null,
  };
}

/**
 * Windows that could cover a failure at or after `since`.
 *
 * Loads unresolved windows plus any that resolved after `since`, so the whole
 * batch can be matched in memory by the pure matcher rather than issuing a query
 * per case.
 */
export async function loadRelevantDowntimeWindows(
  db: PooledDb,
  since: Date,
): Promise<readonly DowntimeWindow[]> {
  const rows = await db
    .select({
      id: downtimeWindows.id,
      issuer: downtimeWindows.issuer,
      method: downtimeWindows.method,
      startedAt: downtimeWindows.startedAt,
      resolvedAt: downtimeWindows.resolvedAt,
      severity: downtimeWindows.severity,
    })
    .from(downtimeWindows)
    .where(or(isNull(downtimeWindows.resolvedAt), gte(downtimeWindows.resolvedAt, since)))
    .orderBy(asc(downtimeWindows.startedAt));

  return rows.map((row) => ({
    id: row.id,
    issuer: row.issuer,
    method: row.method,
    startedAt: row.startedAt,
    resolvedAt: row.resolvedAt,
    severity: row.severity,
  }));
}

/**
 * Windows left open implausibly long.
 *
 * An unresolved window matches every later failure forever, so a missed
 * `.resolved` delivery would silently turn every failure on that bank into
 * `issuer_down`. Surfaced rather than auto-closed: guessing an end time would
 * fabricate data.
 */
export async function findStaleOpenWindows(
  db: PooledDb,
  maxOpenHours: number,
  now: Date,
): Promise<readonly { id: string; issuer: string | null; startedAt: Date }[]> {
  const cutoff = new Date(now.getTime() - maxOpenHours * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: downtimeWindows.id,
      issuer: downtimeWindows.issuer,
      startedAt: downtimeWindows.startedAt,
    })
    .from(downtimeWindows)
    .where(and(isNull(downtimeWindows.resolvedAt), sql`${downtimeWindows.startedAt} < ${cutoff}`));

  return rows;
}
