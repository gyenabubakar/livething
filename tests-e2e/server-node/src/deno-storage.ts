import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';
import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '@livething/server/adapters';
import type { KVProvider, SQLProvider, SqlResult } from '@livething/server/adapters';

// Deno cannot load better-sqlite3, the Node adapter's default, so the e2e
// server passes this node:sqlite storage when it runs on Deno. The Deno docs
// page shows the same code.
export function denoStorage(path: string): { sql: SQLProvider; kv: KVProvider; close(): void } {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  let depth = 0;

  const sql: SQLProvider = {
    limits: {
      maxBoundParams: 32_766,
      maxStatementBytes: 1_000_000_000,
      maxValueBytes: 1_000_000_000,
    },

    exec<TRow>(query: string, ...params: unknown[]): SqlResult<TRow> {
      if (query.trim() === '') return result<TRow>([], []);

      const statement = database.prepare(query);
      if (statement.columns().length === 0) {
        // prepare() reads only the first statement, so a batch without params runs through exec().
        if (params.length === 0) database.exec(query);
        else statement.run(...(params as never[]));

        return result<TRow>([], []);
      }

      statement.setReturnArrays(true);
      const raw = statement.all(...(params as never[])) as unknown as unknown[][];
      const names = statement.columns().map((column) => column.name);
      const rows = raw.map((values) =>
        Object.fromEntries(names.map((name, i) => [name, values[i]])),
      );

      return result(rows as TRow[], raw);
    },

    transaction<T>(fn: () => T): T {
      rejectAsyncTransactionCallback(fn);
      const savepoint = `livething_${depth}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const value = fn();
        rejectAsyncTransactionResult(value);
        database.exec(`RELEASE ${savepoint}`);

        return value;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };

  database.exec(
    'CREATE TABLE IF NOT EXISTS livething_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expires_at INTEGER)',
  );

  function fresh(key: string, expiresAt: number | null): boolean {
    if (expiresAt === null || expiresAt > Date.now()) return true;

    database.prepare('DELETE FROM livething_kv WHERE key = ?').run(key);
    return false;
  }

  const kv: KVProvider = {
    async get(key) {
      const row = database
        .prepare('SELECT value, expires_at FROM livething_kv WHERE key = ?')
        .get(key) as { value: Uint8Array; expires_at: number | null } | undefined;

      return row && fresh(key, row.expires_at) ? deserialize(row.value) : undefined;
    },

    async set(key, value, options) {
      database
        .prepare(
          'INSERT INTO livething_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        )
        .run(key, serialize(value), options?.ttl ? Date.now() + options.ttl : null);
    },

    async delete(key) {
      database.prepare('DELETE FROM livething_kv WHERE key = ?').run(key);
    },

    async list(prefix = '') {
      const pattern = `${prefix.replace(/[*?[]/g, (character) => `[${character}]`)}*`;
      const rows = database
        .prepare('SELECT key, expires_at FROM livething_kv WHERE key GLOB ?')
        .all(pattern) as { key: string; expires_at: number | null }[];

      return rows.filter((row) => fresh(row.key, row.expires_at)).map((row) => row.key);
    },
  };

  return { sql, kv, close: () => database.close() };
}

function result<TRow>(rows: TRow[], raw: unknown[][]): SqlResult<TRow> {
  let readBy: string | undefined;
  function read<T>(reader: string, value: () => T): T {
    if (readBy) throw new Error(`sql.exec() result already consumed by .${readBy}()`);

    readBy = reader;
    return value();
  }

  return {
    toArray: () => read('toArray', () => rows),
    raw: () => read('raw', () => raw),
    one: () =>
      read('one', () => {
        if (rows.length > 1) throw new Error('sql.one() expected at most one row');

        return rows[0] ?? null;
      }),
  };
}
