import type * as PublicApi from '~/context.ts';

/**
 * A framework-namespaced kv key, `__<author>:<name>::<key>`, written by the
 * plugin scope. Such keys legitimately carry `__`/`::`; an app key never does.
 */
const PLUGIN_KV_KEY = /^__[a-z0-9-]+:[a-z0-9-]+::/;

/**
 * Reject a kv key that uses the reserved namespace form. `::` and a leading
 * `__` are reserved for the plugin namespace (`__<id>::<key>`), so an app key
 * may use neither — this stops a handler from colliding with, or reading into,
 * a plugin's kv namespace. A genuine plugin key (built by the plugin scope) is
 * exempt by its well-formed shape, mirroring how channel names are exempted.
 */
function assertWritableKvKey(key: unknown): void {
  if (typeof key !== 'string') return;
  if (!key.startsWith('__') && !key.includes('::')) return;
  if (PLUGIN_KV_KEY.test(key)) return;
  throw new Error(
    `[wskit] kv key '${key}' uses a reserved form: a key may not start with '__' or contain ` +
      `'::' (reserved for the plugin namespace, '__<id>::<key>'). Pick a different key.`,
  );
}

/**
 * Build a `sql`/`kv` view that defers `requireStorage()` until a method is
 * actually invoked. Hooks and tasks that never touch storage stay valid on
 * adapters that do not provide it; hooks that do reach for `ctx.sql.exec(...)`
 * or `ctx.kv.get(...)` still get the adapter's "storage not provided" error
 * at the call site.
 *
 * kv keys are validated against the plugin-namespace reserved form so an app
 * handler can't collide with a plugin's kv; the plugin scope's prefixed keys
 * pass because they match `__<id>::`.
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
      assertWritableKvKey(key);
      return requireStorage().kv.get(key);
    },
    async set(key, value, options) {
      assertWritableKvKey(key);
      return requireStorage().kv.set(key, value, options);
    },
    async delete(key) {
      assertWritableKvKey(key);
      return requireStorage().kv.delete(key);
    },
    async list(prefix) {
      assertWritableKvKey(prefix);
      return requireStorage().kv.list(prefix);
    },
  };
  return { sql, kv };
}
