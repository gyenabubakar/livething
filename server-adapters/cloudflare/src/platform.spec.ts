import { describe, expect, it, vi } from 'vitest';
import { createPlatform } from './platform.ts';
import { createSql, createStorage, createTimers } from './providers.ts';
import { normalizeBinary } from './utils.ts';

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
          exec: vi.fn(() => ({
            toArray: () => rows,
            one: () => rows[0],
            raw: () => [[1], [2]][Symbol.iterator](),
          })),
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

    const result = sql.exec('SELECT * FROM t WHERE id = ?', 1);
    expect(state.storage.sql.exec).toHaveBeenCalledWith('SELECT * FROM t WHERE id = ?', 1);
    expect(result.toArray()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.one()).toEqual({ id: 1 });
    const raw = result.raw();
    expect(Array.isArray(raw)).toBe(true);
  });

  it('returns null from one() when the cursor returns null (empty result set, no throw)', () => {
    const state = {
      storage: {
        sql: {
          exec: () => ({
            toArray: () => [],
            one: () => null,
            raw: () => [][Symbol.iterator](),
          }),
        },
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(sql.exec('SELECT 1 WHERE 0').one()).toBeNull();
  });

  it('returns null from one() when the underlying cursor throws', () => {
    const state = {
      storage: {
        sql: {
          exec: () => ({
            toArray: () => {
              throw new Error('boom');
            },
            one: () => {
              throw new Error('no row');
            },
            raw: () => [][Symbol.iterator](),
          }),
        },
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(sql.exec('SELECT 1').one()).toBeNull();
  });

  it('returns the first row from one() when the cursor has multiple rows', () => {
    const state = {
      storage: {
        sql: {
          exec: () => ({
            toArray: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
            one: () => {
              throw new Error('cursor.one() throws on multi-row');
            },
            raw: () => [][Symbol.iterator](),
          }),
        },
      },
    } as unknown as DurableObjectState;

    const sql = createSql(state);
    expect(sql.exec('SELECT * FROM t').one()).toEqual({ id: 1 });
  });

  it('transaction falls back to inline execution when transactionSync is missing', () => {
    const { state } = fakeState();
    const sql = createSql(state as unknown as DurableObjectState);

    const out = sql.transaction((tx) => {
      const res = tx.exec('INSERT ...');
      return res.toArray().length;
    });
    expect(out).toBe(2);
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
          transactionSync,
        },
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
    // createStorage requires storage.get/put/delete/list for KV; extend it.
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

    const storage = createStorage(state as unknown as DurableObjectState);
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

  it('exposes global setTimeout/clearTimeout bindings', () => {
    const { state } = fakeState();
    const timers = createTimers(state as unknown as DurableObjectState);
    expect(typeof timers.setTimeout).toBe('function');
    expect(typeof timers.clearTimeout).toBe('function');
  });
});

describe('normalizeBinary', () => {
  it('returns ArrayBuffer input unchanged', () => {
    const ab = new ArrayBuffer(4);
    expect(normalizeBinary(ab)).toBe(ab);
  });

  it('slices Uint8Array views to a plain ArrayBuffer containing just the view bytes', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    const view = new Uint8Array(backing.buffer, 1, 3);
    const out = normalizeBinary(view);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(out)).toEqual(new Uint8Array([2, 3, 4]));
  });

  it('encodes strings as UTF-8 ArrayBuffers', () => {
    const out = normalizeBinary('hi');
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(out)).toEqual(new Uint8Array([0x68, 0x69]));
  });
});
