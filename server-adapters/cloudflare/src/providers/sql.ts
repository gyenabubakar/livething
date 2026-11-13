import {
  rejectAsyncTransactionCallback,
  rejectAsyncTransactionResult,
} from '@livething/server/adapters';
import type { SqlLimits, SQLProvider, SqlResult } from '@livething/server/adapters';

/**
 * Durable Object SQLite's real bind-parameter and payload ceilings, as
 * documented at https://developers.cloudflare.com/durable-objects/platform/limits/ —
 * far tighter than stock SQLite's. `maxBoundParams` in particular is easy to
 * blow past: a batched insert or a `WHERE id IN (...)` that assumes a generous
 * cap fails at a small, unremarkable count on this adapter.
 *
 * The row limit is not the 2 MB that page still shows. workerd sets `SQLITE_LIMIT_LENGTH` to
 * 8 MiB + 34 bytes (`MAX_ROW_LENGTH` in src/workerd/util/sqlite.h, since v1.20260925.1), and
 * its tests treat 8,000,000 bytes as the documented value. That length covers one value and
 * one whole row, so this keeps room below it for a row's other columns. Replay, an inbox and a
 * recorded stream do not store a row over it.
 */
const CLOUDFLARE_SQL_LIMITS: SqlLimits = {
  maxBoundParams: 100,
  maxStatementBytes: 100 * 1024,
  maxValueBytes: 8_000_000,
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

      rejectAsyncTransactionCallback(fn);

      const outermost = depth === 0;
      depth += 1;
      try {
        return state.storage.transactionSync(() => {
          const result = fn();
          rejectAsyncTransactionResult(result);

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
 * transaction.
 *
 * Every outermost transaction reads the schema table to find a deferred key. That read is
 * small, and it is not cached: a Durable Object refuses `PRAGMA schema_version`
 * (SQLITE_AUTH), so there is no cheaper way to know the schema did not change. The full
 * `PRAGMA foreign_key_check`, which reads every table with a foreign key, only runs when the
 * schema has a deferred key or the transaction deferred its keys.
 */
function assertDeferredForeignKeysHold(state: DurableObjectState): void {
  const usesDeferredKeys =
    state.storage.sql
      // Both words, not the phrase, because a line break or extra spaces can sit between them.
      // A table or column name that holds only one of the two words does not match. upper()
      // instead of LIKE, which `PRAGMA case_sensitive_like` can make miss a lowercase key.
      .exec(
        "SELECT 1 FROM sqlite_master WHERE instr(upper(sql), 'INITIALLY') > 0 AND instr(upper(sql), 'DEFERRED') > 0 LIMIT 1",
      )
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
