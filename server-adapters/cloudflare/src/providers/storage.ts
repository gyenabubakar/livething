import type { Logger, StorageProvider } from '@wskit/server/adapters';
import { createKv } from './kv.ts';
import { createSql } from './sql.ts';

/**
 * Bundle SQL and KV providers into a single StorageProvider.
 */
export function createStorage(state: DurableObjectState, logger: Logger): StorageProvider {
  return {
    sql: createSql(state),
    kv: createKv(state, logger),
  };
}
