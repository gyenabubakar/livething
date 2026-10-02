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
  it('list returns only keys written via kv, not raw storage keys under the same prefix', async () => {
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

    expect(() => sql.transaction(callback)).toThrow(/\[livething\].*transactionSync/);
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

  describe('deferred foreign keys', () => {
    function stateWith(rowsFor: (query: string) => Record<string, unknown>[]) {
      const queries: string[] = [];
      const state = {
        storage: {
          sql: {
            exec: vi.fn((query: string) => {
              queries.push(query);
              return fakeCursor(rowsFor(query));
            }),
          },
          transactionSync: <T>(closure: () => T) => closure(),
        },
      } as unknown as DurableObjectState;

      return { state, queries };
    }

    it('throws when the schema has a deferred key and the transaction leaves an orphan row', () => {
      const { state } = stateWith((query) => {
        if (query.includes('DEFERRED')) return [{ 1: 1 }];

        if (query === 'PRAGMA foreign_key_check') return [{ table: 'child', rowid: 1 }];

        return [];
      });

      expect(() => createSql(state).transaction(() => 1)).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('does not check anything when no key is deferred', () => {
      const { state, queries } = stateWith(() => []);

      expect(createSql(state).transaction(() => 1)).toBe(1);
      expect(queries).not.toContain('PRAGMA foreign_key_check');
    });

    it('names the table and still checks the next transaction after one that threw', () => {
      const { state, queries } = stateWith((query) => {
        if (query.includes('DEFERRED')) return [{ 1: 1 }];

        if (query === 'PRAGMA foreign_key_check') return [{ table: 'room_members' }];

        return [];
      });
      const sql = createSql(state);

      expect(() =>
        sql.transaction(() => {
          throw new Error('handler failed');
        }),
      ).toThrow('handler failed');
      expect(() => sql.transaction(() => 1)).toThrow(/table "room_members"/);
      expect(queries.filter((query) => query === 'PRAGMA foreign_key_check')).toHaveLength(1);
    });

    describe('with a real SQLite schema', () => {
      // Loaded by name, because this package's tsconfig has no Node types.
      const sqliteModule = 'node:sqlite';

      async function runWithSchema(schema: string): Promise<string[]> {
        const { DatabaseSync } = (await import(sqliteModule)) as {
          DatabaseSync: new (path: string) => {
            exec(sql: string): void;
            prepare(sql: string): { all(): unknown[] };
          };
        };
        const database = new DatabaseSync(':memory:');
        database.exec('CREATE TABLE rooms (id INTEGER PRIMARY KEY)');
        database.exec(schema);
        const queries: string[] = [];

        const state = {
          storage: {
            sql: {
              exec: (query: string) => {
                queries.push(query);
                return fakeCursor(database.prepare(query).all() as Record<string, unknown>[]);
              },
            },
            transactionSync: <T>(closure: () => T) => closure(),
          },
        } as unknown as DurableObjectState;

        createSql(state).transaction(() => 1);

        return queries;
      }

      const CHECK = 'PRAGMA foreign_key_check';

      it('does not check when only a column name contains the word deferred', async () => {
        const queries = await runWithSchema(
          'CREATE TABLE members (roomId INTEGER REFERENCES rooms(id), deferred_at TEXT)',
        );

        expect(queries).not.toContain(CHECK);
      });

      it('checks when a key is declared deferred, on one line or across lines', async () => {
        const oneLine = await runWithSchema(
          'CREATE TABLE members (roomId INTEGER REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED)',
        );
        const acrossLines = await runWithSchema(
          'CREATE TABLE members (roomId INTEGER REFERENCES rooms(id) DEFERRABLE INITIALLY\n    DEFERRED)',
        );

        expect(oneLine).toContain(CHECK);
        expect(acrossLines).toContain(CHECK);
      });
    });

    it('checks when the transaction deferred its keys, once, at the end of the outermost one', () => {
      const { state, queries } = stateWith((query) =>
        query === 'PRAGMA defer_foreign_keys' ? [{ defer_foreign_keys: 1 }] : [],
      );
      const sql = createSql(state);

      sql.transaction(() => sql.transaction(() => 1));

      expect(queries.filter((query) => query === 'PRAGMA foreign_key_check')).toHaveLength(1);
    });
  });

  it('rejects an async callback before it runs', () => {
    const transactionSync = vi.fn(<T>(closure: () => T) => closure());
    const state = {
      storage: { sql: { exec: vi.fn(() => fakeCursor()) }, transactionSync },
    } as unknown as DurableObjectState;
    let ran = false;

    expect(() =>
      createSql(state).transaction(async () => {
        ran = true;
      }),
    ).toThrow(/callbacks must be synchronous/);
    expect(ran).toBe(false);
    expect(transactionSync).not.toHaveBeenCalled();
  });

  it('rejects a sync callback that returns a promise', () => {
    const transactionSync = vi.fn(<T>(closure: () => T) => closure());
    const state = {
      storage: { sql: { exec: vi.fn(() => fakeCursor()) }, transactionSync },
    } as unknown as DurableObjectState;

    expect(() => createSql(state).transaction(() => Promise.resolve(1))).toThrow(
      /callbacks must be synchronous/,
    );
  });

  it('rejects a callback that returns a function with a then method', () => {
    const state = {
      storage: {
        sql: { exec: vi.fn(() => fakeCursor()) },
        transactionSync: <T>(closure: () => T) => closure(),
      },
    } as unknown as DurableObjectState;
    const callableThenable = Object.assign(() => {}, { then() {} });

    expect(() => createSql(state).transaction(() => callableThenable)).toThrow(
      /callbacks must be synchronous/,
    );
  });
});
