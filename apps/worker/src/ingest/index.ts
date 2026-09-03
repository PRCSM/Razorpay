/**
 * Ingest: `raw_events` → `recovery_cases`.
 *
 * `processed_at` doubles as the queue pointer (docs/DATABASE_DESIGN.md), so no
 * separate ingestion queue table is needed: null means unconsumed.
 *
 * Each event is handled in its own TRANSACTION covering both the case insert and
 * the `processed_at` stamp. That pairing is the whole point — if the process dies
 * between them, the transaction rolls back and the event is retried, rather than
 * being marked processed with no case behind it.
 *
 * Recovery-signal events (`payment.captured`, `order.paid`, …) are stamped
 * processed without opening a case. They are not discarded: the raw row is kept
 * for outcome attribution in Run 5.
 */

import { isDowntimeEvent, isRecoverySignalEvent, normalizeEvent } from '@reflow/core';
import type { PooledDb } from '@reflow/db';
import { merchants, rawEvents, recoveryCases } from '@reflow/db';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { upsertDowntimeFromEvent } from './downtime';

export interface IngestSummary {
  readonly scanned: number;
  readonly casesCreated: number;
  readonly signalsRecorded: number;
  /** `payment.downtime.*` events turned into downtime windows. */
  readonly downtimeWindows: number;
  readonly skipped: number;
  readonly failed: number;
  readonly warnings: readonly string[];
}

export interface IngestOptions {
  /** Max events per pass. Bounded so one pass cannot run indefinitely. */
  readonly batchSize?: number;
  /** Injected so ingest is deterministic under test. Core never reads the clock. */
  readonly now?: () => Date;
}

/**
 * The merchant every ingested case is attributed to.
 *
 * Multi-tenancy is modelled but not enforced (docs/ARCHITECTURE.md), and the demo
 * has exactly one seeded merchant. Resolved by name rather than hardcoded so the
 * uuid is never baked into code.
 */
async function resolveDemoMerchantId(db: PooledDb): Promise<string> {
  const found = await db
    .select({ id: merchants.id })
    .from(merchants)
    .orderBy(asc(merchants.createdAt))
    .limit(1);

  const merchant = found[0];
  if (!merchant) {
    throw new Error(
      'No merchant exists. Run `pnpm db:seed` before ingesting — every recovery_case needs a merchant_id.',
    );
  }
  return merchant.id;
}

/**
 * Drain unprocessed events once.
 *
 * Returns a summary rather than throwing on a bad event: one unparseable payload
 * must not stall the queue behind it.
 */
export async function runIngestPass(
  db: PooledDb,
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const batchSize = options.batchSize ?? 200;
  const now = options.now ?? (() => new Date());

  const pending = await db
    .select({
      id: rawEvents.id,
      providerEventId: rawEvents.providerEventId,
      eventType: rawEvents.eventType,
      payload: rawEvents.payload,
      receivedAt: rawEvents.receivedAt,
    })
    .from(rawEvents)
    .where(isNull(rawEvents.processedAt))
    .orderBy(asc(rawEvents.receivedAt))
    .limit(batchSize);

  if (pending.length === 0) {
    return {
      scanned: 0,
      casesCreated: 0,
      signalsRecorded: 0,
      downtimeWindows: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
    };
  }

  const merchantId = await resolveDemoMerchantId(db);

  let casesCreated = 0;
  let signalsRecorded = 0;
  let downtimeCount = 0;
  let skipped = 0;
  let failed = 0;
  const warnings: string[] = [];

  for (const event of pending) {
    try {
      // Downtime events describe the platform, not a case. They become windows
      // that diagnosis consults, and open no recovery case of their own.
      if (isDowntimeEvent(event.eventType)) {
        const result = await upsertDowntimeFromEvent(db, {
          eventType: event.eventType,
          payload: event.payload,
          receivedAt: event.receivedAt ?? now(),
        });

        for (const warning of result.warnings) {
          warnings.push(`${event.eventType} ${event.providerEventId}: ${warning}`);
        }
        if (!result.ok) {
          warnings.push(
            `${event.eventType} ${event.providerEventId}: ${result.reason ?? 'unusable downtime payload'}`,
          );
        } else {
          downtimeCount += 1;
        }

        await db
          .update(rawEvents)
          .set({ processedAt: now() })
          .where(eq(rawEvents.id, event.id));
        continue;
      }

      // Recovery signals open no case. Stamp and move on — the raw row stays.
      if (isRecoverySignalEvent(event.eventType)) {
        await db
          .update(rawEvents)
          .set({ processedAt: now() })
          .where(eq(rawEvents.id, event.id));
        signalsRecorded += 1;
        continue;
      }

      const normalized = normalizeEvent({
        eventType: event.eventType,
        payload: event.payload,
        // The clock is passed in; `receivedAt` is when Razorpay reached us, which
        // is a truer opened_at than whenever the worker happened to wake up.
        receivedAt: event.receivedAt ?? now(),
      });

      if (!normalized.ok) {
        await db
          .update(rawEvents)
          .set({ processedAt: now() })
          .where(eq(rawEvents.id, event.id));
        skipped += 1;
        continue;
      }

      const draft = normalized.draft;

      if (normalized.warnings.length > 0) {
        for (const warning of normalized.warnings) {
          warnings.push(`${event.eventType} ${event.providerEventId}: ${warning}`);
        }
      }

      // Case insert and queue-pointer stamp succeed or fail together.
      await db.transaction(async (tx) => {
        await tx.insert(recoveryCases).values({
          merchantId,
          source: draft.source,
          externalRef: draft.externalRef,
          amountPaise: draft.amountPaise,
          currency: draft.currency,
          customerRef: draft.customerRef,
          method: draft.method,
          issuer: draft.issuer,
          errorCode: draft.errorCode,
          errorSource: draft.errorSource,
          errorStep: draft.errorStep,
          errorReason: draft.errorReason,
          status: 'open',
          openedAt: draft.openedAt,
          isSynthetic: false,
        });

        await tx
          .update(rawEvents)
          .set({ processedAt: now() })
          .where(eq(rawEvents.id, event.id));
      });

      casesCreated += 1;
    } catch (error) {
      // Left unstamped on purpose so the next pass retries it.
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`FAILED ${event.eventType} ${event.providerEventId}: ${detail}`);
    }
  }

  return {
    scanned: pending.length,
    casesCreated,
    signalsRecorded,
    downtimeWindows: downtimeCount,
    skipped,
    failed,
    warnings,
  };
}

/** Count events still awaiting ingestion. */
export async function countPendingEvents(db: PooledDb): Promise<number> {
  const result = await db.execute<{ n: string | number }>(
    sql`SELECT COUNT(*) AS n FROM raw_events WHERE processed_at IS NULL`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
