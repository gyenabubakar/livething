import type { UserTransactionTracker } from '~/_engine/user-transaction.ts';
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
 * A copy of a kv value, so a change made to the value after `set` does not change what
 * is written again after a rollback. A value that cannot be copied is used as it is.
 * A binary view keeps its own type only at the top level, and its whole backing buffer is copied.
 */
function snapshotOf(value: unknown): unknown {
  try {
    const copy = structuredClone(value);
    // structuredClone turns a Node Buffer into a plain Uint8Array. Keep the original type.
    if (ArrayBuffer.isView(value)) {
      return Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    }

    return copy;
  } catch {
    return value;
  }
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
export function createLazyStorageView(
  storage: PublicApi.StorageProvider,
  userTransactions: UserTransactionTracker,
): {
  sql: PublicApi.SQLProvider;
  kv: PublicApi.KVProvider;
} {
  const sql: PublicApi.SQLProvider = {
    exec(query, ...params) {
      return storage.sql.exec(query, ...params);
    },
    transaction(fn) {
      return userTransactions.run(storage.sql, fn);
    },
    limits: storage.sql.limits,
  };

  // A kv write is not part of a SQL transaction, but on some adapters kv shares the SQL
  // connection and would roll back with it, so kv writes are redone like the engine's.
  function setValue(
    key: string,
    value: unknown,
    options?: Parameters<PublicApi.KVProvider['set']>[2],
  ): Promise<void> {
    const outcome = storage.kv.set(key, value, options);
    if (userTransactions.inTransaction) {
      const snapshot = snapshotOf(value);
      const optionsSnapshot = options && { ...options };
      // Providers count a ttl from the moment of each set, so the redo passes only what is left,
      // and the key still expires when it would have.
      const expiresAt = options?.ttl ? Date.now() + options.ttl : undefined;
      userTransactions.recordOperation(() => {
        if (expiresAt === undefined) return storage.kv.set(key, snapshot, optionsSnapshot);

        const remaining = expiresAt - Date.now();
        if (remaining <= 0) return storage.kv.delete(key);

        return storage.kv.set(key, snapshot, { ...optionsSnapshot, ttl: remaining });
      }, outcome);
    }

    return outcome;
  }

  function deleteValue(key: string): Promise<void> {
    const outcome = storage.kv.delete(key);
    userTransactions.recordOperation(() => storage.kv.delete(key), outcome);

    return outcome;
  }

  const privilegedKv: PublicApi.KVProvider = {
    async get(key) {
      return storage.kv.get(key);
    },
    async set(key, value, options) {
      return setValue(key, value, options);
    },
    async delete(key) {
      return deleteValue(key);
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
      return setValue(key, value, options);
    },
    async delete(key) {
      assertWritableKvKey(key);
      return deleteValue(key);
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
