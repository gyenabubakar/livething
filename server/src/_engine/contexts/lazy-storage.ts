import type * as PublicApi from '~/context.ts';

/**
 * Symbol key the lazy kv view carries, pointing at an unguarded kv that skips
 * the app-facing reserved-key guard. The plugin scope reads it to route a
 * plugin's genuine namespaced writes (`__<id>::<key>`) straight through — those
 * keys are built by the framework, not forged by app code, so they are trusted.
 * App handlers never see this symbol, so they can't reach the privileged path.
 */
export const PRIVILEGED_KV = Symbol('livething.privilegedKv');

/**
 * Reject a kv key that uses the reserved namespace form. A leading `__` and `::`
 * are reserved for the plugin namespace (`__<id>::<key>`), so an app key may use
 * neither — this stops a handler from colliding with, or reading/writing into, a
 * plugin's kv namespace by forging a namespaced key. There is NO shape exemption:
 * a genuine plugin write is trusted by going through the privileged path (the
 * `PRIVILEGED_KV` view) the plugin scope holds, not by matching a key shape an
 * app handler could imitate.
 */
function assertWritableKvKey(key: unknown): void {
  if (typeof key !== 'string') return;

  if (!key.startsWith('__') && !key.includes('::')) return;

  throw new Error(
    `[livething] kv key '${key}' uses a reserved form: a key may not start with '__' or contain ` +
      `'::' (reserved for the plugin namespace, '__<id>::<key>'). Pick a different key.`,
  );
}

/** Whether a key belongs to a plugin's namespace — leading `__` or a `::` delimiter. */
function isPluginKey(key: string): boolean {
  return key.startsWith('__') || key.includes('::');
}

/**
 * Build the `sql` and `kv` surfaces exposed on handler and lifecycle
 * contexts, backed by one storage provider.
 *
 * The app-facing `kv` rejects any reserved-form key so an app handler can't
 * collide with, or read into, a plugin's kv namespace, and a bare/empty-prefix
 * `list()` filters plugin keys out. Genuine plugin writes go through the
 * unguarded view exposed under `PRIVILEGED_KV`, which the plugin scope holds —
 * its keys are framework-built, so they bypass the app guard without an
 * app-imitatable shape exemption.
 */
export function createLazyStorageView(storage: PublicApi.StorageProvider): {
  sql: PublicApi.SQLProvider;
  kv: PublicApi.KVProvider;
} {
  const sql: PublicApi.SQLProvider = {
    exec(query, ...params) {
      return storage.sql.exec(query, ...params);
    },
    transaction(fn) {
      return storage.sql.transaction(fn);
    },
    limits: storage.sql.limits,
  };

  const privilegedKv: PublicApi.KVProvider = {
    async get(key) {
      return storage.kv.get(key);
    },
    async set(key, value, options) {
      return storage.kv.set(key, value, options);
    },
    async delete(key) {
      return storage.kv.delete(key);
    },
    async list(prefix) {
      return storage.kv.list(prefix);
    },
  };

  const kv: PublicApi.KVProvider & { [PRIVILEGED_KV]: PublicApi.KVProvider } = {
    async get(key) {
      assertWritableKvKey(key);
      return storage.kv.get(key);
    },
    async set(key, value, options) {
      assertWritableKvKey(key);
      return storage.kv.set(key, value, options);
    },
    async delete(key) {
      assertWritableKvKey(key);
      return storage.kv.delete(key);
    },
    async list(prefix) {
      if (prefix !== undefined && prefix !== '') {
        assertWritableKvKey(prefix);
        return storage.kv.list(prefix);
      }

      const keys = await storage.kv.list(prefix);
      return keys.filter((key) => !isPluginKey(key));
    },
    [PRIVILEGED_KV]: privilegedKv,
  };

  return { sql, kv };
}
