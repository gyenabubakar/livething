import { describe, expect, it, vi } from 'vitest';
import { createKv, createSql } from './providers/index.ts';

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

  it('warns through the engine logger when set() is called with ttl: 0 without leaking the key', async () => {
    const { kv, logger } = createState({});

    await kv.set('session:abc', 'value', { ttl: 0 });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toContain('ttl: 0');
    // Keys often encode user/session ids — they must NOT appear in the
    // warning message, which can be piped into log aggregators.
    expect(message).not.toContain('session:abc');
  });

  it('does not warn for normal set() calls without ttl', async () => {
    const { kv, logger } = createState({});

    await kv.set('foo', 'bar');
    await kv.set('foo', 'bar', { ttl: 1000 });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('createKv — list isolation', () => {
  it('[BUG cf-kv-list] list returns only keys written via kv, not raw storage keys under the same prefix', async () => {
    const { kv, state } = (() => {
      const storageMap = new Map<string, unknown>();
      const s = {
        storage: {
          get: vi.fn(async (key: string) => storageMap.get(key)),
          put: vi.fn(async (key: string, value: unknown) => {
            storageMap.set(key, value);
          }),
          delete: vi.fn(async (key: string) => {
            storageMap.delete(key);
          }),
          list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
            const filtered = new Map<string, unknown>();
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
      return { kv: createKv(s, logger), state: s };
    })();

    await kv.set('p:a', 'via-kv');
    await state.storage.put('p:b', 'raw');

    const keys = await kv.list('p:');

    expect(keys).toContain('p:a');
    expect(keys).not.toContain('p:b');
  });
});

describe('createSql.exec — one-shot result contract', () => {
  function fakeCursor(rows: Record<string, unknown>[] = []) {
    const iter = rows[Symbol.iterator]();
    return {
      toArray: () => {
        const remaining: Record<string, unknown>[] = [];
        for (let next = iter.next(); !next.done; next = iter.next()) {
          remaining.push(next.value);
        }
        return remaining;
      },
      [Symbol.iterator]: () => iter,
      raw: () => {
        const remaining: unknown[][] = [];
        for (let next = iter.next(); !next.done; next = iter.next()) {
          remaining.push(Object.values(next.value));
        }
        return remaining;
      },
    };
  }

  function stateWithCursor(rows: Record<string, unknown>[]) {
    return {
      storage: {
        sql: {
          exec: vi.fn(() => fakeCursor(rows)),
        },
      },
    } as unknown as DurableObjectState;
  }

  it('throws on a second method call against the same result', () => {
    const sql = createSql(stateWithCursor([{ id: 1, name: 'a' }]));
    const result = sql.exec('SELECT id, name FROM things');

    expect(result.toArray()).toEqual([{ id: 1, name: 'a' }]);
    expect(() => result.toArray()).toThrow(/already consumed by \.toArray\(\)/);
    expect(() => result.one()).toThrow(/already consumed by \.toArray\(\)/);
    expect(() => result.raw()).toThrow(/already consumed by \.toArray\(\)/);
  });

  it('reports the method that was used first when guarding the second call', () => {
    const sql = createSql(stateWithCursor([]));
    const result = sql.exec('SELECT 1');

    result.one();
    expect(() => result.toArray()).toThrow(/already consumed by \.one\(\)/);
  });

  it('lets a fresh exec() call run independently after a previous result was consumed', () => {
    const state = stateWithCursor([{ id: 1 }]);
    const sql = createSql(state);

    sql.exec('SELECT id FROM things').one();
    // A second exec() builds a fresh cursor wrapper — its methods are
    // independent of the previous result's consumed state.
    expect(() => sql.exec('SELECT id FROM things').toArray()).not.toThrow();
  });

  it('throws even when one() returned null (empty result still consumes)', () => {
    const sql = createSql(stateWithCursor([]));
    const result = sql.exec('SELECT id FROM things WHERE id = -1');

    expect(result.one()).toBeNull();
    expect(() => result.toArray()).toThrow(/already consumed by \.one\(\)/);
  });
});

describe('createSql.transaction', () => {
  function fakeCursor(rows: Record<string, unknown>[] = []) {
    const iter = rows[Symbol.iterator]();
    return {
      toArray: () => [...rows],
      [Symbol.iterator]: () => iter,
      raw: () => rows.map((row) => Object.values(row)),
    };
  }

  it('does not throw at construction when transactionSync is missing', () => {
    const state = {
      storage: {
        sql: {
          exec: vi.fn(() => fakeCursor()),
          // No transactionSync.
        },
      },
    } as unknown as DurableObjectState;

    expect(() => createSql(state)).not.toThrow();
  });

  it('throws on transaction() when transactionSync is missing, before invoking the callback', () => {
    const state = {
      storage: {
        sql: {
          exec: vi.fn(() => fakeCursor()),
        },
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    const callback = vi.fn();

    expect(() => sql.transaction(callback)).toThrow(/\[wskit\].*transactionSync/);
    expect(callback).not.toHaveBeenCalled();
  });

  it('uses storage.transactionSync when available', () => {
    const transactionSync = vi.fn(<T>(closure: () => T) => closure());
    const state = {
      storage: {
        sql: {
          exec: vi.fn(() => fakeCursor()),
        },
        transactionSync,
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    const result = sql.transaction(() => 42);

    expect(result).toBe(42);
    expect(transactionSync).toHaveBeenCalledTimes(1);
  });
});
