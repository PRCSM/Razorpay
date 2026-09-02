/**
 * @reflow/db — Drizzle schema, migrations, and client factories.
 * The only place SQL lives (docs/ARCHITECTURE.md, package boundaries).
 */

export * from './schema/index';
export {
  closeAllPools,
  createPooledDb,
  createServerlessDb,
  schema,
  type PooledDb,
  type PooledDbOptions,
  type Schema,
  type ServerlessDb,
} from './client';
export { TABLE_NAMES, DOMAIN_TABLE_NAMES } from './table-names';
