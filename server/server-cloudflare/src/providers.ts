import type {
  KVProvider,
  SQLProvider,
  SqlResult,
  StorageProvider,
  TimerProvider,
} from '@wskit/server/adapters';

type SqlStorageWithTransaction = SqlStorage & {
  transactionSync?<T>(closure: () => T): T;
};

function wrapCursor(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): SqlResult {
  return {
    toArray: () => cursor.toArray() as Record<string, unknown>[],
    one: () => (cursor.one() as Record<string, unknown>) ?? null,
    raw: () => [...cursor.raw()] as unknown[][],
  };
}

export function createSql(state: DurableObjectState): SQLProvider {
  const sql = state.storage.sql as SqlStorageWithTransaction;
  return {
    exec(query, ...params) {
      return wrapCursor(sql.exec(query, ...params));
    },
    transaction<T>(fn: (tx: { exec(query: string, ...params: unknown[]): SqlResult }) => T): T {
      if (typeof sql.transactionSync === 'function') {
        return sql.transactionSync(() =>
          fn({ exec: (query, ...params) => wrapCursor(sql.exec(query, ...params)) }),
        );
      }
      return fn({
        exec: (query, ...params) => wrapCursor(sql.exec(query, ...params)),
      });
    },
  };
}

export function createKv(state: DurableObjectState): KVProvider {
  return {
    async get(key) {
      const entry = (await state.storage.get(key)) as
        | { value: unknown; expiresAt?: number }
        | undefined;
      if (!entry) return undefined;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        await state.storage.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, options) {
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
      return [...result.keys()];
    },
  };
}

export function createStorage(state: DurableObjectState): StorageProvider {
  return {
    sql: createSql(state),
    kv: createKv(state),
  };
}

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
