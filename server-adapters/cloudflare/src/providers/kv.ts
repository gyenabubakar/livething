import type { KVProvider, Logger } from '@wskit/server/adapters';

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
 * Create a KVProvider backed by Durable Object SQLite with built-in TTL (time-to-live)
 * support for automatic key expiry.
 *
 * When `kv.set()` is called with `ttl: 0`, the provider emits a warning
 * (without the key name) since `0` is treated as "no expiry" rather than
 * "expire immediately". Use a positive ttl or omit it to avoid the warning.
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
          const raw = result.get(key);
          if (typeof raw !== 'object' || raw === null || !('value' in raw)) return null;
          return (await readFreshKvEntry(state, key, raw as KvEntry)) ? key : null;
        }),
      );
      return freshKeys.filter((key): key is string => key !== null);
    },
  };
}
