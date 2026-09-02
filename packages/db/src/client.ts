/**
 * Client factories.
 *
 * docs/DATABASE_DESIGN.md, "Connections": the web app uses Neon's serverless
 * HTTP driver; the worker uses a POOLED connection with a small pool and a short
 * idle timeout, so Neon can auto-suspend between scheduled jobs and stay inside
 * free-tier compute hours.
 *
 * Two drivers, one schema. Both are created lazily and memoised per connection
 * string, because a Next.js route handler may be invoked many times per process
 * and each new pool costs a Neon connection.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export type Schema = typeof schema;

/** Web / serverless: one HTTP round trip per query, no connection to hold open. */
export type ServerlessDb = NeonHttpDatabase<Schema>;

/** Worker / long-running: a small TCP pool over the pooled Neon endpoint. */
export type PooledDb = NodePgDatabase<Schema>;

const serverlessCache = new Map<string, ServerlessDb>();
const pooledCache = new Map<string, { db: PooledDb; pool: Pool }>();

/**
 * HTTP-driver client for request-scoped code (Next.js route handlers, RSC).
 *
 * No transactions across statements — the HTTP driver cannot hold one. Anything
 * needing a transaction belongs in the worker, using {@link createPooledDb}.
 */
export function createServerlessDb(databaseUrl: string): ServerlessDb {
  const cached = serverlessCache.get(databaseUrl);
  if (cached) return cached;

  const sql = neon(databaseUrl);
  const db = drizzleHttp(sql, { schema, casing: 'snake_case' });
  serverlessCache.set(databaseUrl, db);
  return db;
}

export interface PooledDbOptions {
  /**
   * Keep this small. Neon's free tier bills compute time, and the worker is a
   * single process doing one job at a time.
   */
  readonly max?: number;
  /** Release idle connections quickly so Neon can auto-suspend. */
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

/** Pooled client plus the underlying pool, so the worker can close it on shutdown. */
export function createPooledDb(
  databaseUrl: string,
  options: PooledDbOptions = {},
): { db: PooledDb; pool: Pool } {
  const cached = pooledCache.get(databaseUrl);
  if (cached) return cached;

  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 4,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    // Neon requires TLS. `sslmode=require` in the URL covers verification mode;
    // this makes the intent explicit for the node-postgres driver.
    ssl: databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });

  const db = drizzleNode(pool, { schema, casing: 'snake_case' });
  const entry = { db, pool };
  pooledCache.set(databaseUrl, entry);
  return entry;
}

/** Close every pool this module opened. For worker shutdown and test teardown. */
export async function closeAllPools(): Promise<void> {
  const pools = [...pooledCache.values()].map((entry) => entry.pool);
  pooledCache.clear();
  await Promise.all(pools.map((pool) => pool.end()));
}

export { schema };
