import { describe, expect, it, vi } from 'vitest';
import { createKv } from './providers.ts';

type KvEntry = { value: unknown; expiresAt?: number };

function createState(entries: Record<string, KvEntry>) {
  const storageMap = new Map<string, KvEntry>(Object.entries(entries));
  const deleteSpy = vi.fn(async (key: string) => {
    storageMap.delete(key);
  });

  const state = {
    storage: {
      get: vi.fn(async (key: string) => storageMap.get(key)),
      put: vi.fn(async (key: string, value: KvEntry) => {
        storageMap.set(key, value);
      }),
      delete: deleteSpy,
      list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
        const filtered = new Map<string, KvEntry>();
        for (const [key, value] of storageMap) {
          if (!prefix || key.startsWith(prefix)) {
            filtered.set(key, value);
          }
        }
        return filtered;
      }),
    },
  } as unknown as DurableObjectState;

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { kv: createKv(state, logger), storageMap, deleteSpy, logger };
}

describe('createKv', () => {
  it('returns undefined and deletes an expired key on get', async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { kv, storageMap, deleteSpy } = createState({
      stale: { value: 'old', expiresAt: now - 1 },
    });

    await expect(kv.get('stale')).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith('stale');
    expect(storageMap.has('stale')).toBe(false);

    vi.useRealTimers();
  });

  it('filters and deletes expired keys during list', async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { kv, storageMap, deleteSpy } = createState({
      'chat:live': { value: 'a', expiresAt: now + 10_000 },
      'chat:stale': { value: 'b', expiresAt: now - 1 },
      'other:stale': { value: 'c', expiresAt: now - 1 },
    });

    await expect(kv.list('chat:')).resolves.toEqual(['chat:live']);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('chat:stale');
    expect(storageMap.has('chat:stale')).toBe(false);
    expect(storageMap.has('other:stale')).toBe(true);

    vi.useRealTimers();
  });

  it('warns through the engine logger when set() is called with ttl: 0', async () => {
    const { kv, logger } = createState({});

    await kv.set('session:abc', 'value', { ttl: 0 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('kv.set("session:abc"'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ttl of 0'));
  });

  it('does not warn for normal set() calls without ttl', async () => {
    const { kv, logger } = createState({});

    await kv.set('foo', 'bar');
    await kv.set('foo', 'bar', { ttl: 1000 });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
