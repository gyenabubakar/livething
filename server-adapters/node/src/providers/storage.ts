import type { KVProvider, Logger, StorageProvider } from '@livething/server/adapters';
import { createKv } from './kv.ts';
import { createSql } from './sql.ts';
import type { NodeSqlSource, SqliteDatabase } from './sql.ts';

/** Storage dependencies accepted by the Node server. */
export interface NodeStorageOptions {
  sql?: NodeSqlSource;
  kv?: KVProvider;
  logger?: Logger;
}

/** Storage providers plus the resources the Node adapter must close. */
export interface NodeStorageRuntime {
  storage: StorageProvider;
  close(): void;
}

/** Creates the Node SQL and KV providers from the server options. */
export function createStorage(options: NodeStorageOptions = {}): NodeStorageRuntime {
  const sql = createSql(options.sql);

  let kv: KVProvider;
  try {
    kv = options.kv ?? createDefaultKv(sql.database, options.logger);
  } catch (error) {
    sql.close();
    throw error;
  }

  return {
    storage: { sql: sql.provider, kv },
    close: sql.close,
  };
}

function createDefaultKv(database: SqliteDatabase | undefined, logger?: Logger): KVProvider {
  if (!database) {
    throw new Error(
      '[livething] Node storage needs a SQLite database for ctx.kv. Provide a better-sqlite3 or node:sqlite database, or inject a KVProvider when using a custom SQLProvider.',
    );
  }

  return createKv(database, logger);
}
