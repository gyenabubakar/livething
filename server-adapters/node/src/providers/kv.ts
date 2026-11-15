import { deserialize, serialize } from 'node:v8';
import type { KVProvider, Logger } from '@livething/server/adapters';
import type { SqliteDatabase } from './sql.ts';

const KV_TABLE = '__livething_kv';

interface KvRow {
  key: string;
  value: string;
  expiresAt: number | null;
}

/** Creates the SQLite-backed KV provider used by the Node runtime by default. */
export function createKv(database: SqliteDatabase, logger?: Logger): KVProvider {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${KV_TABLE} (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `);

  const getStatement = database.prepare(
    `SELECT key, value, expires_at AS expiresAt FROM ${KV_TABLE} WHERE key = ?`,
  );
  const setStatement = database.prepare(
    `INSERT INTO ${KV_TABLE} (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  );
  const deleteStatement = database.prepare(`DELETE FROM ${KV_TABLE} WHERE key = ?`);
  const listStatement = database.prepare(
    `SELECT key, value, expires_at AS expiresAt FROM ${KV_TABLE} WHERE key GLOB ?`,
  );

  function readFresh(row: KvRow | undefined): KvRow | undefined {
    if (!row) return undefined;

    // Expire lazily so reads and prefix listings do not return stale values.
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      deleteStatement.run(row.key);
      return undefined;
    }

    return row;
  }

  return {
    async get(key) {
      const row = readFresh(getStatement.get(key) as KvRow | undefined);
      return row ? decode(row.value) : undefined;
    },

    async set(key, value, options) {
      if (options?.ttl === 0) {
        logger?.warn(
          '[livething] kv.set called with { ttl: 0 } — Node treats 0 as "no expiry". Pass a positive number of milliseconds to enable expiry, or omit ttl.',
        );
      }

      setStatement.run(key, encode(value), options?.ttl ? Date.now() + options.ttl : null);
    },

    async delete(key) {
      deleteStatement.run(key);
    },

    async list(prefix) {
      const pattern = prefix === undefined ? '*' : `${escapeGlob(prefix)}*`;
      const rows = listStatement.all(pattern) as KvRow[];
      const keys: string[] = [];

      for (const row of rows) {
        if (readFresh(row)) keys.push(row.key);
      }

      return keys;
    },
  };
}

function encode(value: unknown): string {
  return serialize(value).toString('base64');
}

function decode(value: string): unknown {
  return deserialize(Buffer.from(value, 'base64'));
}

function escapeGlob(value: string): string {
  return value.replace(/[*?[]/g, (character) => `[${character}]`);
}
