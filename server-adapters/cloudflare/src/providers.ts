import type {
  KVProvider,
  Logger,
  SQLProvider,
  SqlResult,
  StorageProvider,
  TimerProvider,
} from '@wskit/server/adapters';

type SqlStorageWithTransaction = SqlStorage & {
  transactionSync?<T>(closure: () => T): T;
};

function wrapCursor<TRow = unknown>(
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
): SqlResult<TRow> {
  return {
    toArray: () => cursor.toArray() as TRow[],
    one: () => {
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
    raw: () => [...cursor.raw()] as unknown[][],
  };
}

type KvEntry = { value: unknown; expiresAt?: number };

async function readFreshKvEntry(
  state: DurableObjectState,
  key: string,
  entry?: KvEntry,
): Promise<KvEntry | undefined> {
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    await state.storage.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * Create an SQLProvider backed by Cloudflare Durable Object SQLite storage.
 * Supports `exec()` for queries and `transaction()` for atomic operations.
 */
export function createSql(state: DurableObjectState): SQLProvider {
  const sql = state.storage.sql as SqlStorageWithTransaction;
  return {
    exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
      return wrapCursor<TRow>(sql.exec(query, ...params));
    },
    transaction<T>(
      fn: (tx: { exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> }) => T,
    ): T {
      if (typeof sql.transactionSync === 'function') {
        return sql.transactionSync(() =>
          fn({
            exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
              return wrapCursor<TRow>(sql.exec(query, ...params));
            },
          }),
        );
      }
      return fn({
        exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> {
          return wrapCursor<TRow>(sql.exec(query, ...params));
        },
      });
    },
  };
}

/**
 * Create a KVProvider backed by Durable Object SQLite with built-in TTL (time-to-live)
 * support for automatic key expiry.
 *
 * When `kv.set()` is called with `ttl: 0`, the provider emits a warning that
 * includes the key name, since `0` is treated as "no expiry" rather than
 * "expire immediately". If your key names encode sensitive data (for example
 * `session:${userId}`), the key name will appear in the warning output — use
 * a non-zero ttl or omit it to avoid the warning.
 */
export function createKv(state: DurableObjectState, logger: Logger): KVProvider {
  return {
    async get(key) {
      const entry = (await state.storage.get(key)) as KvEntry | undefined;
      return (await readFreshKvEntry(state, key, entry))?.value;
    },
    async set(key, value, options) {
      if (options?.ttl === 0) {
        // Don't include the key in the message — keys often encode user or
        // session ids and would leak into log output. The user can locate
        // the call site via their own log context or a stack trace.
        logger.warn(
          '[wskit] kv.set called with { ttl: 0 } — Cloudflare treats 0 as "no expiry". Pass a positive number of milliseconds to enable expiry, or omit ttl.',
        );
      }
      await state.storage.put(key, {
        value,
        expiresAt: options?.ttl ? Date.now() + options.ttl : undefined,
      });
    },
    async delete(key) {
      await state.storage.delete(key);
    },
    async list(prefix) {
      const result = await state.storage.list({ prefix });
      const keys = [...result.keys()];
      const freshKeys = await Promise.all(
        keys.map(async (key) => {
          const entry = result.get(key) as KvEntry | undefined;
          return (await readFreshKvEntry(state, key, entry)) ? key : null;
        }),
      );
      return freshKeys.filter((key): key is string => key !== null);
    },
  };
}

/**
 * Bundle SQL and KV providers into a single StorageProvider.
 */
export function createStorage(state: DurableObjectState, logger: Logger): StorageProvider {
  return {
    sql: createSql(state),
    kv: createKv(state, logger),
  };
}

/**
 * Create a TimerProvider backed by Durable Object alarms (for persistent wake-ups)
 * and `setTimeout` (for in-memory delays).
 */
export function createTimers(state: DurableObjectState): TimerProvider {
  return {
    async setAlarm(timeMs) {
      await state.storage.setAlarm(timeMs);
    },
    async deleteAlarm() {
      await state.storage.deleteAlarm();
    },
    async getAlarm() {
      return state.storage.getAlarm();
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}
