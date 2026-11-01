import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '@livething/server/adapters';
import Database from 'better-sqlite3';
import type { SqlLimits, SQLProvider, SqlResult } from '@livething/server/adapters';

/** The limits reported to LiveThing by better-sqlite3. */
const BETTER_SQLITE3_LIMITS: SqlLimits = {
  maxBoundParams: 32_766,
  maxStatementBytes: 1_000_000_000,
  maxValueBytes: 1_000_000_000,
};

export type NodeSqlDatabase = Database.Database;

/** A file path, existing database, or fully configured SQL provider. */
export type NodeSqlSource = string | NodeSqlDatabase | SQLProvider;

/** The SQL provider and ownership information used by the Node runtime. */
export interface NodeSqlRuntime {
  provider: SQLProvider;
  database?: NodeSqlDatabase;
  close(): void;
}

/** Creates a SQL provider, using an in-memory database when no source is given. */
export function createSql(source: NodeSqlSource = ':memory:'): NodeSqlRuntime {
  if (isSqlProvider(source)) {
    return { provider: source, close() {} };
  }

  const database = typeof source === 'string' ? new Database(source) : source;
  const ownsDatabase = typeof source === 'string';
  database.pragma('foreign_keys = ON');

  return {
    provider: createSqlProvider(database),
    database,
    close() {
      if (ownsDatabase) database.close();
    },
  };
}

function isSqlProvider(source: NodeSqlSource): source is SQLProvider {
  return (
    typeof source === 'object' &&
    'limits' in source &&
    typeof source.exec === 'function' &&
    typeof source.transaction === 'function'
  );
}

function createSqlProvider(database: NodeSqlDatabase): SQLProvider {
  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    const trimmed = query.trim();

    if (trimmed.length === 0) return emptyResult<TRow>();

    let statement: Database.Statement<unknown[], unknown>;
    try {
      statement = database.prepare(trimmed) as Database.Statement<unknown[], unknown>;
    } catch (error) {
      if (params.length > 0) throw error;

      // The public SQL contract is one statement, but the engine uses an
      // unparameterized batch for schema setup. Let SQLite parse that batch so
      // semicolons inside string literals remain part of the SQL.
      database.exec(trimmed);
      return emptyResult<TRow>();
    }

    if (statement.reader) {
      const columns = statement.columns().map((column) => column.name);
      const rawRows = statement.raw().all(...(params as never[])) as unknown[][];
      const rows = rawRows.map((values) =>
        Object.fromEntries(columns.map((name, index) => [name, values[index]])),
      ) as TRow[];
      return createResult(rows, rawRows);
    }

    statement.run(...(params as never[]));

    return emptyResult<TRow>();
  }

  return {
    exec,
    limits: BETTER_SQLITE3_LIMITS,
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
