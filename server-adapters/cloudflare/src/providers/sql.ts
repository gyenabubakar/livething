import type { SqlLimits, SQLProvider, SqlResult } from '@livething/server/adapters';

/**
 * Durable Object SQLite's real bind-parameter and payload ceilings, as
 * documented at https://developers.cloudflare.com/durable-objects/platform/limits/ —
 * far tighter than stock SQLite's. `maxBoundParams` in particular is easy to
 * blow past: a batched insert or a `WHERE id IN (...)` that assumes a generous
 * cap fails at a small, unremarkable count on this adapter.
 */
const CLOUDFLARE_SQL_LIMITS: SqlLimits = {
  maxBoundParams: 100,
  maxStatementBytes: 100 * 1024,
  maxValueBytes: 2 * 1024 * 1024,
};

function wrapCursor<TRow = unknown>(
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
): SqlResult<TRow> {
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
    toArray: () => {
      claim('toArray');
      return cursor.toArray() as TRow[];
    },
    one: () => {
      claim('one');

      const iter = cursor[Symbol.iterator]();
      const first = iter.next();
      if (first.done) return null;

      const second = iter.next();
      if (!second.done) {
        throw new Error(
          '[livething] sql.one() expected at most one row, but the query returned multiple. Add LIMIT 1 to the SQL, or use .toArray().',
        );
      }

      return first.value as TRow;
    },
    raw: () => {
      claim('raw');
      return [...cursor.raw()] as unknown[][];
    },
  };
}

/**
 * Create an SQLProvider backed by Cloudflare Durable Object SQLite storage.
 * Supports `exec()` for queries and `transaction()` for atomic operations.
 *
 * `transaction()` throws when the runtime lacks `storage.transactionSync` rather
 * than downgrading to plain `exec()` calls — that would break the all-or-nothing
 * contract and leave a partially-executed callback's writes committed.
 */
export function createSql(state: DurableObjectState): SQLProvider {
  let depth = 0;

  return {
    exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
      return wrapCursor<TRow>(state.storage.sql.exec(query, ...params));
    },
    limits: CLOUDFLARE_SQL_LIMITS,
    transaction<T>(fn: () => T): T {
      if (typeof state.storage.transactionSync !== 'function') {
        throw new Error(
          '[livething] this Cloudflare runtime does not support atomic transactions. ' +
            'ctx.sql.transaction() requires storage.transactionSync(). Upgrade your ' +
            'Cloudflare Workers runtime, or in tests provide a mock storage that ' +
            'implements transactionSync.',
        );
      }

      if (isAsyncFunction(fn)) throw synchronousTransactionError();

      const outermost = depth === 0;
      depth += 1;
      try {
        return state.storage.transactionSync(() => {
          const result = fn();
          if (isPromiseLike(result)) throw synchronousTransactionError();

          if (outermost) assertDeferredForeignKeysHold(state);

          return result;
        });
      } finally {
        depth -= 1;
      }
    },
  };
}

/**
 * A deferred foreign key is checked when the transaction commits. Durable Objects
 * reset the whole object when that check fails, and the error cannot be caught.
 * Checking before the commit turns the reset into an error that rolls back the
 * transaction. The check reads every table with a foreign key, so it only runs when
 * the schema has a deferred key or the transaction deferred its keys.
 */
function assertDeferredForeignKeysHold(state: DurableObjectState): void {
  const usesDeferredKeys =
    state.storage.sql
      // Only DEFERRED, because the two words can have a line break or more spaces between them.
      .exec("SELECT 1 FROM sqlite_master WHERE sql LIKE '%DEFERRED%' LIMIT 1")
      .toArray().length > 0 ||
    state.storage.sql.exec('PRAGMA defer_foreign_keys').toArray()[0]?.defer_foreign_keys === 1;
  if (!usesDeferredKeys) return;

  const violations = state.storage.sql.exec('PRAGMA foreign_key_check').toArray();
  if (violations.length > 0) {
    throw new Error(
      `FOREIGN KEY constraint failed: the transaction left ${violations.length} row(s) in ` +
        `table "${String(violations[0]?.table)}" without a matching parent row, so it was rolled back.`,
    );
  }
}

function isAsyncFunction(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    Object.getPrototypeOf(value)?.constructor?.name === 'AsyncFunction'
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function synchronousTransactionError(): TypeError {
  return new TypeError(
    '[livething] sql.transaction() callbacks must be synchronous. Run async work before or after the transaction.',
  );
}
