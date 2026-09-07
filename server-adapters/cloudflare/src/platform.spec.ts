import { describe, expect, it, vi } from 'vitest';
import { createPlatform } from './platform.ts';
import { createSql, createStorage, createTimers } from './providers/index.ts';

function fakeCursor<T>(rows: T[]) {
  return {
    toArray: () => rows,
    one: () => rows[0],
    raw: () => rows.map((r) => Object.values(r as Record<string, unknown>))[Symbol.iterator](),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeState() {
  let alarm: number | null = null;
  const rows = [{ id: 1 }, { id: 2 }];
  return {
    state: {
      blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      getWebSockets: vi.fn(() => []),
      waitUntil: vi.fn(),
      storage: {
        sql: {
          exec: vi.fn(() => fakeCursor(rows)),
        },
        setAlarm: vi.fn(async (t: number) => {
          alarm = t;
        }),
        getAlarm: vi.fn(async () => alarm),
        deleteAlarm: vi.fn(async () => {
          alarm = null;
        }),
      },
    },
    getAlarm: () => alarm,
  };
}

describe('createPlatform', () => {
  it('returns an object with ctx methods and env passthrough', () => {
    const { state } = fakeState();
    const env = { FOO: 'bar' };
    const platform = createPlatform(state as unknown as DurableObjectState, env);

    expect(platform.env).toBe(env);
    expect(typeof platform.ctx.blockConcurrencyWhile).toBe('function');
    expect(typeof platform.ctx.getWebSockets).toBe('function');
    expect(typeof platform.ctx.waitUntil).toBe('function');
    expect(platform.ctx.storage).toBe(state.storage);
  });

  it('calls through to state.blockConcurrencyWhile and getWebSockets', async () => {
    const { state } = fakeState();
    const platform = createPlatform(state as unknown as DurableObjectState, {});
    await platform.ctx.blockConcurrencyWhile(async () => 42);
    expect(state.blockConcurrencyWhile).toHaveBeenCalled();

    platform.ctx.getWebSockets('tag-a');
    expect(state.getWebSockets).toHaveBeenCalledWith('tag-a');
  });
});

describe('createSql', () => {
  it('wraps cursor into { toArray, one, raw }', () => {
    const { state } = fakeState();
    const sql = createSql(state as unknown as DurableObjectState);

    const arrayResult = sql.exec('SELECT * FROM t WHERE id = ?', 1);
    expect(state.storage.sql.exec).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?', 1);
    expect(arrayResult.toArray()).toEqual([{ id: 1 }, { id: 2 }]);

    const rawResult = sql.exec('SELECT * FROM t WHERE id = ?', 1);
    expect(Array.isArray(rawResult.raw())).toBe(true);
  });

  it('one() returns the row when the cursor has exactly one row', () => {
    const state = {
      storage: { sql: { exec: () => fakeCursor([{ id: 7 }]) } },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(sql.exec('SELECT 1').one()).toEqual({ id: 7 });
  });

  it('one() returns null when the cursor is empty', () => {
    const state = {
      storage: { sql: { exec: () => fakeCursor([]) } },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(sql.exec('SELECT 1 WHERE 0').one()).toBeNull();
  });

  it('one() throws when the cursor has more than one row', () => {
    const state = {
      storage: { sql: { exec: () => fakeCursor([{ id: 1 }, { id: 2 }]) } },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(() => sql.exec('SELECT * FROM t').one()).toThrow(
      /expected at most one row, but the query returned multiple/,
    );
  });

  it('one() propagates errors thrown by the underlying cursor iterator', () => {
    const state = {
      storage: {
        sql: {
          exec: () => ({
            toArray: () => [],
            one: () => null,
            raw: () => [][Symbol.iterator](),
            [Symbol.iterator]: () => {
              throw new Error('sql failure');
            },
          }),
        },
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(() => sql.exec('SELECT bad').one()).toThrow(/sql failure/);
  });

  it('transaction throws when transactionSync is missing instead of silently degrading', () => {
    const { state } = fakeState();
    const sql = createSql(state as unknown as DurableObjectState);

    expect(() => sql.transaction((tx) => tx.exec('INSERT ...').toArray().length)).toThrow(
      /\[wskit\].*transactionSync/,
    );
  });

  it('transaction uses transactionSync when the storage exposes it', () => {
    const transactionSync = vi.fn(<T>(fn: () => T) => fn());
    const state = {
      storage: {
        sql: {
          exec: () => ({
            toArray: () => [],
            one: () => null,
            raw: () => [][Symbol.iterator](),
          }),
        },
        transactionSync,
      },
    } as unknown as DurableObjectState;
    const sql = createSql(state);
    sql.transaction((tx) => tx.exec('...'));
    expect(transactionSync).toHaveBeenCalledTimes(1);
  });
});

describe('createStorage', () => {
  it('returns bundled sql + kv providers', () => {
    const { state } = fakeState();
    const kvMap = new Map<string, unknown>();
    (state.storage as unknown as Record<string, unknown>).get = vi.fn(async (k: string) =>
      kvMap.get(k),
    );
    (state.storage as unknown as Record<string, unknown>).put = vi.fn(
      async (k: string, v: unknown) => {
        kvMap.set(k, v);
      },
    );
    (state.storage as unknown as Record<string, unknown>).delete = vi.fn(async (k: string) => {
      kvMap.delete(k);
    });

    (state.storage as unknown as Record<string, unknown>).list = vi.fn(async () => new Map());

    const storage = createStorage(state as unknown as DurableObjectState, noopLogger);
    expect(typeof storage.sql.exec).toBe('function');
    expect(typeof storage.kv.get).toBe('function');
  });
});

describe('createTimers', () => {
  it('round-trips setAlarm and getAlarm through state.storage', async () => {
    const { state, getAlarm } = fakeState();
    const timers = createTimers(state as unknown as DurableObjectState);

    await timers.setAlarm!(1_700_000_000);
    expect(state.storage.setAlarm).toHaveBeenCalledWith(1_700_000_000);
    expect(getAlarm()).toBe(1_700_000_000);

    await expect(timers.getAlarm!()).resolves.toBe(1_700_000_000);

    await timers.deleteAlarm!();
    expect(state.storage.deleteAlarm).toHaveBeenCalled();
    expect(getAlarm()).toBeNull();
  });
});
