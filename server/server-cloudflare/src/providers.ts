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
    one: () => {
      try {
        return (cursor.one() as Record<string, unknown>) ?? null;
      } catch {
        return null;
      }
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
      const entry = (await state.storage.get(key)) as KvEntry | undefined;
      return (await readFreshKvEntry(state, key, entry))?.value;
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
