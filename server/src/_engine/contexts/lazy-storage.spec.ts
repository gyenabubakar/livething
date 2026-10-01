/* oxlint-disable @typescript-eslint/no-explicit-any */
import { createLazyStorageView, PRIVILEGED_KV } from '~/_engine/contexts/lazy-storage.ts';
import { UserTransactionTracker } from '~/_engine/user-transaction.ts';
import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it, vi } from 'vitest';

function view(listResult: string[] = []) {
  const kvImpl = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => listResult),
  };

  const storage: any = { sql: {}, kv: kvImpl };
  return { ...createLazyStorageView(storage, new UserTransactionTracker(() => {})), kvImpl };
}

describe('lazy kv — reserved-key guard (kv namespace hardening)', () => {
  it('rejects an app key starting with __ or containing ::', async () => {
    const { kv } = view();
    await expect(kv.set('__count', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.set('a::b', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.get('__x')).rejects.toThrow(/reserved form/);
    await expect(kv.delete('x::y')).rejects.toThrow(/reserved form/);

    await expect(kv.list('__')).rejects.toThrow(/reserved form/);
  });

  it('allows a normal app key', async () => {
    const { kv, kvImpl } = view();
    await kv.set('count', 1);
    expect(kvImpl.set).toHaveBeenCalledWith('count', 1, undefined);
    await kv.get('session');
    expect(kvImpl.get).toHaveBeenCalledWith('session');
  });

  it('app cannot forge a well-formed plugin-namespaced key (#11 — no shape exemption)', async () => {
    const { kv, kvImpl } = view();
    await expect(kv.set('__acme:store::secret', 1)).rejects.toThrow(/reserved form/);
    await expect(kv.get('__acme:store::secret')).rejects.toThrow(/reserved form/);
    await expect(kv.delete('__acme:store::secret')).rejects.toThrow(/reserved form/);
    expect(kvImpl.set).not.toHaveBeenCalled();

    expect(kvImpl.get).not.toHaveBeenCalled();
    expect(kvImpl.delete).not.toHaveBeenCalled();
  });

  it('genuine plugin writes go through the privileged kv (#11)', async () => {
    const { kv, kvImpl } = view();
    const privileged = (kv as any)[PRIVILEGED_KV];
    await privileged.set('__acme:store::count', 1);
    expect(kvImpl.set).toHaveBeenCalledWith('__acme:store::count', 1, undefined);
    await privileged.get('__acme:store::count');

    expect(kvImpl.get).toHaveBeenCalledWith('__acme:store::count');
  });
});

describe('lazy kv — writes inside a rolled-back sql transaction', () => {
  it('keeps kv writes even when kv shares the sql connection and the transaction rolls back', () => {
    const sql = createTestSql();
    sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
    const sharedKv: any = {
      async set(key: string, value: string) {
        sql.exec('INSERT OR REPLACE INTO kv VALUES (?, ?)', key, value);
      },
      async delete(key: string) {
        sql.exec('DELETE FROM kv WHERE key = ?', key);
      },
    };

    const { sql: userSql, kv } = createLazyStorageView(
      { sql, kv: sharedKv } as any,
      new UserTransactionTracker(() => {}),
    );
    const privileged = (kv as any)[PRIVILEGED_KV];

    sql.exec("INSERT INTO kv VALUES ('gone', 'x')");

    expect(() =>
      userSql.transaction(() => {
        void kv.set('app', 'a');
        void privileged.set('__plugin::key', 'p');
        void kv.delete('gone');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(sql.exec('SELECT key FROM kv ORDER BY key').toArray()).toEqual([
      { key: '__plugin::key' },
      { key: 'app' },
    ]);
  });

  it('redoes the value as it was when it was written, not as it was changed later', async () => {
    const store = new Map<string, unknown>();
    const kvImpl: any = {
      async set(key: string, value: unknown) {
        store.set(key, structuredClone(value));
      },
      async delete(key: string) {
        store.delete(key);
      },
    };

    const { sql, kv } = createLazyStorageView(
      { sql: createTestSql(), kv: kvImpl } as any,
      new UserTransactionTracker(() => {}),
    );
    const value = { count: 1 };

    expect(() =>
      sql.transaction(() => {
        void kv.set('key', value);
        value.count = 999;
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(store.get('key')).toEqual({ count: 1 });
  });

  it('keeps a Buffer as it is and still redoes a value that cannot be cloned', () => {
    const calls: { key: string; value: unknown }[] = [];
    const kvImpl: any = {
      async set(key: string, value: unknown) {
        calls.push({ key, value });
      },
    };

    const { sql, kv } = createLazyStorageView(
      { sql: createTestSql(), kv: kvImpl } as any,
      new UserTransactionTracker(() => {}),
    );
    const buffer = Buffer.from('abc');
    const notCloneable = { run() {} };

    expect(() =>
      sql.transaction(() => {
        void kv.set('buffer', buffer);
        void kv.set('function', notCloneable);
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(calls.map((call) => call.key)).toEqual(['buffer', 'function', 'buffer', 'function']);
    expect(calls[2]?.value).toBe(buffer);
    expect(calls[3]?.value).toBe(notCloneable);
  });

  it('does not report a kv write that was rejected the first time', async () => {
    const errors: unknown[] = [];
    const kvImpl: any = {
      async set() {
        throw new Error('kv refused');
      },
    };

    const { sql, kv } = createLazyStorageView(
      { sql: createTestSql(), kv: kvImpl } as any,
      new UserTransactionTracker((error) => errors.push(error)),
    );

    expect(() =>
      sql.transaction(() => {
        kv.set('key', 1).catch(() => {});
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([]);
  });
});

describe('lazy kv — list isolation (#12)', () => {
  it('app list() with no prefix filters out every plugin key', async () => {
    const { kv } = view(['count', '__acme:store::secret', 'session', 'a::b']);
    expect(await kv.list()).toEqual(['count', 'session']);
    expect(await kv.list('')).toEqual(['count', 'session']);
  });

  it('app list(prefix) keeps the reserved-form guard', async () => {
    const { kv } = view();
    await expect(kv.list('__acme')).rejects.toThrow(/reserved form/);
  });

  it('the privileged kv list() returns everything unfiltered', async () => {
    const { kv } = view(['__acme:store::count', '__acme:store::seen']);
    const privileged = (kv as any)[PRIVILEGED_KV];
    expect(await privileged.list('__acme:store::')).toEqual([
      '__acme:store::count',
      '__acme:store::seen',
    ]);
  });
});
