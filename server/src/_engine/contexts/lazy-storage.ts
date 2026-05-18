import type * as PublicApi from '~/context.ts';

/**
 * Build a `sql`/`kv` view that defers `requireStorage()` until a method is
 * actually invoked. Hooks and tasks that never touch storage stay valid on
 * adapters that do not provide it; hooks that do reach for `ctx.sql.exec(...)`
 * or `ctx.kv.get(...)` still get the adapter's "storage not provided" error
 * at the call site.
 */
export function createLazyStorageView(requireStorage: () => PublicApi.StorageProvider): {
  sql: PublicApi.SQLProvider;
  kv: PublicApi.KVProvider;
} {
  const sql: PublicApi.SQLProvider = {
    exec(query, ...params) {
      return requireStorage().sql.exec(query, ...params);
    },
    transaction(fn) {
      return requireStorage().sql.transaction(fn);
    },
  };
  const kv: PublicApi.KVProvider = {
    async get(key) {
      return requireStorage().kv.get(key);
    },
    async set(key, value, options) {
      return requireStorage().kv.set(key, value, options);
    },
    async delete(key) {
      return requireStorage().kv.delete(key);
    },
    async list(prefix) {
      return requireStorage().kv.list(prefix);
    },
  };
  return { sql, kv };
}
