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

interface CloudflareTransactionContext {
  exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow>;
}

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
  return {
    exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
      return wrapCursor<TRow>(state.storage.sql.exec(query, ...params));
    },
    limits: CLOUDFLARE_SQL_LIMITS,
    transaction<T>(fn: (tx: CloudflareTransactionContext) => T): T {
      if (typeof state.storage.transactionSync !== 'function') {
        throw new Error(
          '[livething] this Cloudflare runtime does not support atomic transactions. ' +
            'ctx.sql.transaction() requires storage.transactionSync(). Upgrade your ' +
            'Cloudflare Workers runtime, or in tests provide a mock storage that ' +
            'implements transactionSync.',
        );
      }

      return state.storage.transactionSync(() =>
        fn({
          exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
            return wrapCursor<TRow>(state.storage.sql.exec(query, ...params));
          },
        }),
      );
    },
  };
}
