/**
 * Shared bootstrap for the database CLI scripts.
 *
 * These run as standalone Node processes, so they load `.env.local` from the
 * repository root themselves, then validate through the same Zod schema in
 * `@reflow/core` that the applications use. No script gets its own looser rules.
 */

import { getDbEnv } from '@reflow/core';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

/** Absolute path to the repository root (packages/db/src/scripts → ../../../..). */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

/** Load `.env.local`, then validate. Throws a named error if anything is missing. */
export function bootstrapDbEnv(): { databaseUrl: string } {
  loadDotenv({ path: resolve(repoRoot, '.env.local'), quiet: true });
  const env = getDbEnv();
  return { databaseUrl: env.DATABASE_URL };
}

/** Redact a connection string for logging. Never print a live password. */
export function describeConnection(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.protocol}//${url.username}:***@${url.host}${url.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}
