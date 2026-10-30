import { DatabaseSync } from 'node:sqlite';
import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '~/_adapters/sync-transaction.ts';
import type { KVProvider, SqlLimits, SQLProvider, SqlResult, StorageProvider } from '~/context.ts';

/**
 * The real limits of the `node:sqlite` build Node 24 ships. Used as
 * {@link createTestSql}'s default so existing tests keep passing unchanged —
 * override `limits` to test a batching boundary at a small, readable count
 * instead of tens of thousands of rows.
 */
const NODE_SQLITE_LIMITS: SqlLimits = {
  maxBoundParams: 32_766,
  maxStatementBytes: 1_000_000_000,
  maxValueBytes: 1_000_000_000,
};

/** Options for {@link createTestSql}. */
export interface TestSqlOptions {
  /**
   * Called with the raw query and params on every `exec`, including the ones a
   * `transaction()` callback runs. Lets a spec count real writes without giving
   * up a real database — used where "how many statements ran" is the invariant.
   */
  onExec?: (query: string, params: readonly unknown[]) => void;

  /**
   * Override the provider's {@link SqlLimits}. Defaults to
   * {@link NODE_SQLITE_LIMITS}. Pass a partial object — unset fields keep
   * their default — so a spec can shrink just `maxBoundParams` to exercise
   * `chunkForBind` batching with a handful of rows instead of tens of
   * thousands.
   *
   * ```ts
   * const sql = createTestSql({ limits: { maxBoundParams: 4 } });
   * ```
   */
  limits?: Partial<SqlLimits>;
}

/**
 * A real in-memory SQLite database, wired to the `SQLProvider` contract, for
 * any storage test that should exercise the actual SQL rather than a hand-rolled
 * fake. The storage layer leans on `MAX(seq)`, `OFFSET`, `GROUP BY`,
 * `INSERT OR REPLACE`, foreign-key cascades, and primary-key constraints that a
 * fake can only guess at, so these specs run against the engine Node ships.
 *
 * A statement starting with `SELECT`, `WITH`, or `PRAGMA table_info` is read as
 * a query; anything else is a write. A write may bundle several
 * `;`-separated statements (a schema batch) — the leading statements run
 * unparameterized and the params bind onto the last one.
 */
export function createTestSql(options: TestSqlOptions = {}): SQLProvider & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  const limits: SqlLimits = { ...NODE_SQLITE_LIMITS, ...options.limits };

  function exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
    options.onExec?.(query, params);
    const trimmed = query.trim();

    if (/^\s*(SELECT|WITH|PRAGMA\s+table_info)/i.test(trimmed)) {
      const rows = db.prepare(trimmed).all(...(params as never[])) as TRow[];
      return {
        toArray: () => rows,
        one() {
          if (rows.length > 1) throw new Error('.one() saw more than one row');

          return rows[0] ?? null;
        },
        raw: () => rows.map((row) => Object.values(row as Record<string, unknown>)),
      };
    }

    const statements = trimmed
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    const last = statements.pop()!;
    for (const statement of statements) db.exec(statement);
    db.prepare(last).run(...(params as never[]));

    return emptyResult<TRow>();
  }

  let depth = 0;

  return {
    db,
    exec,
    limits,
    // Nested calls become savepoints, like better-sqlite3 does. Async callbacks
    // are rejected, like the real providers do.
    transaction<T>(fn: () => T): T {
      rejectAsyncTransactionCallback(fn);

      const outermost = depth === 0;
      const savepoint = `sp${depth}`;
      db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      depth += 1;
      let result: T;

      try {
        result = fn();
        rejectAsyncTransactionResult(result);
      } catch (error) {
        depth -= 1;
        // SQLite may have ended the transaction itself, as INSERT OR ROLLBACK does.
        if (db.isTransaction) {
          db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        }

        throw error;
      }

      depth -= 1;
      try {
        db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      } catch (error) {
        // A failed COMMIT (a deferred foreign key, say) leaves the transaction open.
        if (outermost && db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }

      return result;
    },
  };
}

function emptyResult<TRow>(): SqlResult<TRow> {
  return { toArray: () => [], one: () => null, raw: () => [] };
}

/**
 * An in-memory `KVProvider` for any test that needs a `storage.kv` value but
 * isn't exercising kv behavior itself. Backed by a plain `Map`, so it never
 * persists across instances.
 */
export function createTestKV(): KVProvider {
  const store = new Map<string, unknown>();
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list(prefix) {
      const keys = [...store.keys()];
      return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
    },
  };
}

/**
 * A real `StorageProvider` for tests that need to build an engine — real
 * SQLite via {@link createTestSql} paired with an in-memory `kv`. Every
 * `EngineOptions` needs a `storage` value; use this shared implementation
 * rather than hand-rolling one per spec.
 */
export function createTestStorage(
  options: TestSqlOptions = {},
): StorageProvider & { db: DatabaseSync } {
  const sql = createTestSql(options);
  return { sql, kv: createTestKV(), db: sql.db };
}
