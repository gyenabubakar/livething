import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '@livething/server/adapters';
import Database from 'better-sqlite3';
import type { SqlLimits, SQLProvider, SqlResult } from '@livething/server/adapters';
import type { DatabaseSync } from 'node:sqlite';
import { isNodeSqliteDatabase, wrapNodeSqlite } from './node-sqlite.ts';

/** The default SQLite limits, which better-sqlite3 and node:sqlite both keep. */
const SQLITE_LIMITS: SqlLimits = {
  maxBoundParams: 32_766,
  maxStatementBytes: 1_000_000_000,
  maxValueBytes: 1_000_000_000,
};

type NodeSqlDatabase = Database.Database;

/** A file path, a better-sqlite3 or `node:sqlite` database, or a fully configured SQL provider. */
export type NodeSqlSource = string | NodeSqlDatabase | DatabaseSync | SQLProvider;

/** The part of a better-sqlite3 statement that the SQL and KV providers use. */
export interface SqliteStatement {
  readonly reader: boolean;
  columns(): { name: string }[];
  raw(): { all(...params: unknown[]): unknown[] };
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The part of a better-sqlite3 database that the SQL and KV providers use. */
export interface SqliteDatabase {
  prepare(query: string): SqliteStatement;
  /**
   * SQLite's schema version, for a driver whose prepared statement keeps the old columns for one
   * run after the schema changed. The SQL provider then prepares its statements again.
   */
  schemaVersion?(): unknown;
  exec(query: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

/** The SQL provider and ownership information used by the Node runtime. */
export interface NodeSqlRuntime {
  provider: SQLProvider;
  database?: SqliteDatabase;
  close(): void;
}

/** Creates a SQL provider, using an in-memory database when no source is given. */
export function createSql(source: NodeSqlSource = ':memory:'): NodeSqlRuntime {
  if (isSqlProvider(source)) {
    return { provider: source, close() {} };
  }

  const ownsDatabase = typeof source === 'string';
  const database = openDatabase(source);
  database.exec('PRAGMA foreign_keys = ON');

  return {
    provider: createSqlProvider(database),
    database,
    close() {
      if (ownsDatabase) database.close();
    },
  };
}

function openDatabase(source: string | NodeSqlDatabase | DatabaseSync): SqliteDatabase {
  if (typeof source === 'string') return new Database(source) as unknown as SqliteDatabase;

  if (isNodeSqliteDatabase(source)) return wrapNodeSqlite(source);

  return source as unknown as SqliteDatabase;
}

function isSqlProvider(source: NodeSqlSource): source is SQLProvider {
  return (
    typeof source === 'object' &&
    'limits' in source &&
    typeof source.exec === 'function' &&
    typeof source.transaction === 'function'
  );
}

/**
 * How many prepared statements one database keeps. An app and the engine run a small, fixed set
 * of SQL texts, so this holds all of them. SQL built with values in its text gets a new entry for
 * each value and pushes out the oldest one.
 */
const STATEMENT_CACHE_SIZE = 128;
// ponytail: DDL on a temp table or an attached database run on the app's own handle, outside
// this provider, is not seen here; node:sqlite then gives one `SELECT *` the old columns.
const SCHEMA_KEYWORD = /(?:ALTER|CREATE|DROP|ATTACH|DETACH)\b/iy;

/** Whether the statement's first keyword, after any comments, changes the schema. */
function changesSchema(query: string): boolean {
  let index = 0;
  while (index < query.length) {
    if (query.startsWith('--', index)) {
      const end = query.indexOf('\n', index);
      if (end === -1) return false;

      index = end + 1;
    } else if (query.startsWith('/*', index)) {
      const end = query.indexOf('*/', index + 2);
      if (end === -1) return false;

      index = end + 2;
    } else if (/\s/.test(query[index]!)) {
      index++;
    } else {
      break;
    }
  }

  SCHEMA_KEYWORD.lastIndex = index;

  return SCHEMA_KEYWORD.test(query);
}

function createSqlProvider(database: SqliteDatabase): SQLProvider {
  // Least recently used first, so the oldest entry is the first key.
  const statements = new Map<string, SqliteStatement>();
  let schemaVersion: unknown;

  function prepare(query: string): SqliteStatement {
    if (database.schemaVersion) {
      const version = database.schemaVersion();
      if (version !== schemaVersion) {
        statements.clear();
        schemaVersion = version;
      }
    }

    const cached = statements.get(query);
    if (cached) {
      statements.delete(query);
      statements.set(query, cached);

      return cached;
    }

    const statement = database.prepare(query);
    if (statements.size >= STATEMENT_CACHE_SIZE) {
      statements.delete(statements.keys().next().value!);
    }

    statements.set(query, statement);

    return statement;
  }

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const trimmed = query.trim();

    if (trimmed.length === 0) return emptyResult<TRow>();

    let statement: SqliteStatement;
    try {
      statement = prepare(trimmed);
    } catch (error) {
      if (params.length > 0) throw error;

      // The public SQL contract is one statement, but the engine uses an
      // unparameterized batch for schema setup. Let SQLite parse that batch so
      // semicolons inside string literals remain part of the SQL.
      // A batch that fails halfway has still run its first statements.
      try {
        database.exec(trimmed);
      } finally {
        statements.clear();
      }

      return emptyResult<TRow>();
    }

    if (statement.reader) {
      const rawRows = statement.raw().all(...params) as unknown[][];
      // Read after running: SQLite prepares a cached statement again when the schema changed,
      // so a `SELECT *` can have more columns than when it was first prepared.
      const columns = statement.columns().map((column) => column.name);
      return createResult(rawRows.map((values) => rowObject(columns, values)) as TRow[], rawRows);
    }

    statement.run(...params);
    // The schema version only covers the main database, so a change to a temp table or an
    // attached database must also drop the cached statements.
    if (changesSchema(trimmed)) statements.clear();

    return emptyResult<TRow>();
  }

  return {
    exec,
    limits: SQLITE_LIMITS,
    transaction<T>(fn: () => T): T {
      rejectAsyncTransactionCallback(fn);

      const runTransaction = database.transaction(() => {
        const result = fn();
        rejectAsyncTransactionResult(result);

        return result;
      });

      return runTransaction();
    },
  };
}

/** One row as an object. A later column wins over an earlier one with the same name. */
function rowObject(
  columns: readonly string[],
  values: readonly unknown[],
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < columns.length; index++) row[columns[index]!] = values[index];

  return row;
}

function createResult<TRow>(rows: TRow[], rawRows: unknown[][] = []): SqlResult<TRow> {
  let consumed: 'toArray' | 'one' | 'raw' | null = null;

  function claim(method: 'toArray' | 'one' | 'raw'): void {
    if (consumed) {
      throw new Error(
        `[livething] sql.exec() result already consumed by .${consumed}(). Call exactly one of .toArray() / .one() / .raw() per exec(). Run the query again if you need both shapes.`,
      );
    }

    consumed = method;
  }

  return {
    toArray() {
      claim('toArray');
      return rows;
    },

    one() {
      claim('one');
      if (rows.length > 1) {
        throw new Error(
          '[livething] sql.one() expected at most one row, but the query returned multiple. Add LIMIT 1 to the SQL, or use .toArray().',
        );
      }

      return rows[0] ?? null;
    },

    raw() {
      claim('raw');
      return rawRows;
    },
  };
}

function emptyResult<TRow>(): SqlResult<TRow> {
  return createResult<TRow>([]);
}
