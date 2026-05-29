import type { SQLProvider, SqlResult } from '@wskit/server/adapters';

function wrapCursor<TRow = unknown>(
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
): SqlResult<TRow> {
  let consumed: 'toArray' | 'one' | 'raw' | null = null;
  function claim(method: 'toArray' | 'one' | 'raw'): void {
    if (consumed) {
      throw new Error(
        `[wskit] sql.exec() result already consumed by .${consumed}(). Call exactly one of .toArray() / .one() / .raw() per exec(). Run the query again if you need both shapes.`,
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
          '[wskit] sql.one() expected at most one row, but the query returned multiple. Add LIMIT 1 to the SQL, or use .toArray().',
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
 */
export function createSql(state: DurableObjectState): SQLProvider {
  return {
    exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
      return wrapCursor<TRow>(state.storage.sql.exec(query, ...params));
    },
    transaction<T>(
      fn: (tx: { exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> }) => T,
    ): T {
      if (typeof state.storage.transactionSync !== 'function') {
        // Refuse to silently downgrade `transaction(callback)` to plain
        // exec() calls — that breaks the documented all-or-nothing contract
        // and leaves writes from a partially-executed callback committed.
        // Throw before invoking the callback so the caller can react.
        throw new Error(
          '[wskit] this Cloudflare runtime does not support atomic transactions. ' +
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
