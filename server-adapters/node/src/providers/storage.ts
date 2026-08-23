import type { KVProvider, Logger, StorageProvider } from '@wskit/server/adapters';
import { createKv } from './kv.ts';
import { createSql } from './sql.ts';
import type { NodeSqlDatabase, NodeSqlSource } from './sql.ts';

export interface NodeStorageOptions {
  sql?: NodeSqlSource;
  kv?: KVProvider;
  logger?: Logger;
}

export interface NodeStorageRuntime {
  storage: StorageProvider;
  close(): void;
}

export function createStorage(options: NodeStorageOptions = {}): NodeStorageRuntime {
  const sql = createSql(options.sql);
  const kv = options.kv ?? createDefaultKv(sql.database, options.logger);

  return {
    storage: { sql: sql.provider, kv },
    close: sql.close,
  };
}

function createDefaultKv(database: NodeSqlDatabase | undefined, logger?: Logger): KVProvider {
  if (!database) {
    throw new Error(
      '[wskit] Node storage needs a SQLite database for ctx.kv. Provide a better-sqlite3 database or inject a KVProvider when using a custom SQLProvider.',
    );
  }
  return createKv(database, logger);
}
