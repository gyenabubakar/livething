import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  KVProvider,
  Logger,
  SqlLimits,
  SQLProvider,
  SqlResult,
} from '@livething/server/adapters';
import { createAsyncContext } from './async-context.ts';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createKv } from './providers/kv.ts';
import { createSql } from './providers/sql.ts';
import { createStorage } from './providers/storage.ts';
import { createTimers } from './providers/timers.ts';
import { createRuntime } from './runtime.ts';

describe('createAsyncContext', () => {
  it('keeps the active store across an awaited callback', async () => {
    const context = createAsyncContext<{ requestId: string }>();

    await context.run({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      expect(context.getStore()).toEqual({ requestId: 'req-1' });
    });

    expect(context.getStore()).toBeUndefined();
  });
});

// The SQL and KV tests run on each SQLite driver that the `sql` option accepts.
const drivers: [string, () => ReturnType<typeof createSql>][] = [
  ['better-sqlite3', () => createSql()],
  ['node:sqlite', () => createSql(new DatabaseSync(':memory:'))],
];

describe.each(drivers)('createSql on %s', (_driver, openSql) => {
  it('keeps a column named __proto__ as a plain column', () => {
    const runtime = openSql();
    try {
      const row = runtime.provider
        .exec<Record<string, unknown>>("SELECT 1 AS __proto__, x'00' AS bytes")
        .one();

      if (!row) throw new Error('expected one row');

      expect(Object.keys(row)).toEqual(['__proto__', 'bytes']);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toBe(1);
    } finally {
      runtime.close();
    }
  });

  it('runs real SQLite reads, writes, raw results, and schema batches', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec(
        `PRAGMA foreign_keys = ON;
         CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT);
         CREATE INDEX messages_id ON messages(id)`,
      );
      runtime.provider.exec('INSERT INTO messages (id, body) VALUES (?, ?)', 1, 'hello');

      expect(
        runtime.provider
          .exec<{ id: number; body: string }>('SELECT id, body FROM messages')
          .toArray(),
      ).toEqual([{ id: 1, body: 'hello' }]);
      expect(runtime.provider.exec('SELECT id, body FROM messages').raw()).toEqual([[1, 'hello']]);
      expect(runtime.provider.exec('SELECT body FROM messages WHERE id = ?', 1).one()).toEqual({
        body: 'hello',
      });
      expect(runtime.provider.limits.maxBoundParams).toBe(32_766);
    } finally {
      runtime.close();
    }
  });

  it('rolls back the complete transaction when its callback throws', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('CREATE TABLE values_table (value TEXT)');

      expect(() =>
        runtime.provider.transaction(() => {
          runtime.provider.exec('INSERT INTO values_table (value) VALUES (?)', 'kept out');
          throw new Error('stop');
        }),
      ).toThrow('stop');

      expect(runtime.provider.exec('SELECT value FROM values_table').toArray()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('undoes only the inner writes when an outer callback catches an inner failure', () => {
    const runtime = openSql();
    try {
      const { provider } = runtime;
      provider.exec('CREATE TABLE values_table (value TEXT)');

      provider.transaction(() => {
        provider.exec('INSERT INTO values_table (value) VALUES (?)', 'outer');
        try {
          provider.transaction(() => {
            provider.exec('INSERT INTO values_table (value) VALUES (?)', 'inner');
            throw new Error('inner failed');
          });
        } catch {
          // the outer callback continues
        }
      });

      expect(provider.exec('SELECT value FROM values_table').toArray()).toEqual([
        { value: 'outer' },
      ]);
    } finally {
      runtime.close();
    }
  });

  it('rejects an async callback before it can write outside the transaction', () => {
    const runtime = openSql();
    let ran = false;
    async function callback() {
      ran = true;
    }

    try {
      expect(() => runtime.provider.transaction(callback)).toThrow(
        /transaction\(\) callbacks must be synchronous/,
      );
      expect(ran).toBe(false);
    } finally {
      runtime.close();
    }
  });

  it('rejects a callback that returns a function with a then method, and rolls back', () => {
    const runtime = openSql();
    const callableThenable = Object.assign(() => {}, { then() {} });

    try {
      runtime.provider.exec('CREATE TABLE values_table (value TEXT)');
      expect(() =>
        runtime.provider.transaction(() => {
          runtime.provider.exec("INSERT INTO values_table VALUES ('x')");

          return callableThenable;
        }),
      ).toThrow(/transaction\(\) callbacks must be synchronous/);
      expect(runtime.provider.exec('SELECT value FROM values_table').toArray()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('returns rows from a write statement with RETURNING', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

      expect(
        runtime.provider
          .exec<{ id: number }>('INSERT INTO users (name) VALUES (?) RETURNING id', 'Ada')
          .one(),
      ).toEqual({ id: 1 });
    } finally {
      runtime.close();
    }
  });

  it('does not split a semicolon inside a SQL string literal', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('CREATE TABLE messages (body TEXT)');
      runtime.provider.exec("INSERT INTO messages (body) VALUES ('hello;world')");

      expect(runtime.provider.exec('SELECT body FROM messages').one()).toEqual({
        body: 'hello;world',
      });
    } finally {
      runtime.close();
    }
  });

  it('consumes an empty result exactly once', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('CREATE TABLE values_table (value TEXT)');
      const result = runtime.provider.exec('INSERT INTO values_table (value) VALUES (?)', 'one');

      expect(result.one()).toBeNull();
      expect(() => result.toArray()).toThrow(/already consumed by \.one\(\)/);
    } finally {
      runtime.close();
    }
  });

  it('returns an empty result for an empty query', () => {
    const runtime = openSql();
    try {
      expect(runtime.provider.exec('  ').toArray()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('runs every statement of a parameter-free batch that starts with a read', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('SELECT 1; CREATE TABLE later (value TEXT)');

      expect(runtime.provider.exec('SELECT value FROM later').toArray()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('runs one statement that ends with a comment', () => {
    const runtime = openSql();
    try {
      expect(runtime.provider.exec('SELECT ? AS value; -- the topic', 5).one()).toEqual({
        value: 5,
      });
      expect(runtime.provider.exec('SELECT 1 AS value; /* no params */').one()).toEqual({
        value: 1,
      });
    } finally {
      runtime.close();
    }
  });

  it('refuses a value SQLite cannot store, such as a Date', () => {
    const runtime = openSql();
    try {
      runtime.provider.exec('CREATE TABLE events (at TEXT)');

      expect(() => runtime.provider.exec('INSERT INTO events VALUES (?)', new Date(0))).toThrow(
        TypeError,
      );
      expect(runtime.provider.exec('SELECT at FROM events').toArray()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it('binds undefined as NULL', () => {
    const runtime = openSql();
    try {
      expect(runtime.provider.exec('SELECT ? AS value', undefined).one()).toEqual({ value: null });
    } finally {
      runtime.close();
    }
  });

  it('returns a BLOB as a Buffer', () => {
    const runtime = openSql();
    try {
      const { value } = runtime.provider
        .exec<{ value: Buffer }>('SELECT ? AS value', Uint8Array.of(1, 2))
        .one()!;

      expect(Buffer.isBuffer(value)).toBe(true);
      expect(value.toString('hex')).toBe('0102');
    } finally {
      runtime.close();
    }
  });

  it("keeps the callback's error after the callback rolled back on its own", () => {
    const runtime = openSql();
    try {
      expect(() =>
        runtime.provider.transaction(() => {
          runtime.provider.exec('ROLLBACK');
          throw new Error('handler failed');
        }),
      ).toThrow('handler failed');
    } finally {
      runtime.close();
    }
  });

  it('rolls back and throws when the commit fails, and stays usable', () => {
    const runtime = openSql();
    try {
      const { provider } = runtime;
      provider.exec(
        `CREATE TABLE rooms (id INTEGER PRIMARY KEY);
         CREATE TABLE messages (
           room_id INTEGER REFERENCES rooms(id) DEFERRABLE INITIALLY DEFERRED
         )`,
      );

      expect(() =>
        provider.transaction(() => {
          provider.exec('INSERT INTO messages (room_id) VALUES (?)', 7);
        }),
      ).toThrow(/FOREIGN KEY/);
      expect(provider.exec('SELECT room_id FROM messages').toArray()).toEqual([]);

      provider.transaction(() => provider.exec('INSERT INTO rooms (id) VALUES (?)', 1));
      expect(provider.exec('SELECT id FROM rooms').toArray()).toEqual([{ id: 1 }]);
    } finally {
      runtime.close();
    }
  });
});

describe('createSql', () => {
  // node:sqlite binds a missing value as NULL and cannot tell, so this holds for better-sqlite3 only.
  it('throws on a missing parameter value with better-sqlite3', () => {
    const runtime = createSql();
    try {
      runtime.provider.exec('CREATE TABLE messages (body TEXT)');

      expect(() => runtime.provider.exec('INSERT INTO messages VALUES (?)')).toThrow(
        /Too few parameter values/,
      );
    } finally {
      runtime.close();
    }
  });

  it('does not close an injected SQL provider', () => {
    const provider = createFakeSqlProvider();
    const runtime = createSql(provider);

    expect(runtime.provider).toBe(provider);
    expect(() => runtime.close()).not.toThrow();
  });

  it('closes its owned database when default KV initialization fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'livething-storage-'));
    const databasePath = join(directory, 'state.sqlite');
    const setup = new Database(databasePath);
    setup.exec('CREATE TABLE __livething_kv (wrong_column TEXT)');
    setup.close();

    const close = vi.spyOn(Database.prototype, 'close');
    try {
      expect(() => createStorage({ sql: databasePath })).toThrow(/no such column/);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // `StatementSync.columns()` and `setReturnArrays()` came in Node 22.16.
  it('names the Node version when node:sqlite is too old', () => {
    const database = new DatabaseSync(':memory:');
    const older = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare') {
          return (query: string) => Object.assign(target.prepare(query), { columns: undefined });
        }

        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(() => createSql(older)).toThrow(/Node\.js 22\.16 or newer/);
    database.close();
  });

  it('keeps ctx.kv in a node:sqlite database it was given, and never closes it', async () => {
    const database = new DatabaseSync(':memory:');
    const storage = createStorage({ sql: database });

    await storage.storage.kv.set('topic', 'launch');
    storage.close();

    expect(database.isOpen).toBe(true);
    expect(database.prepare('SELECT key FROM __livething_kv').all()).toEqual([{ key: 'topic' }]);
    database.close();
  });
});

// The provider keeps prepared statements, so these run the same SQL text again after the schema changed.
describe.each(drivers)('createSql statement reuse on %s', (_driver, openSql) => {
  it('gives a SELECT * the columns added since it last ran', () => {
    const sql = openSql();
    try {
      sql.provider.exec('CREATE TABLE rooms (id TEXT)');
      sql.provider.exec("INSERT INTO rooms VALUES ('general')");
      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([{ id: 'general' }]);

      sql.provider.exec("ALTER TABLE rooms ADD COLUMN topic TEXT DEFAULT 'launch'");

      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([
        { id: 'general', topic: 'launch' },
      ]);
    } finally {
      sql.close();
    }
  });

  it.each([
    ['a temp table', 'CREATE TEMP TABLE rooms (id TEXT)', 'rooms'],
    ['an attached database', "ATTACH ':memory:' AS archive", 'archive.rooms'],
  ])('gives a SELECT * the columns added to %s', (_place, setup, table) => {
    const sql = openSql();
    try {
      sql.provider.exec(setup);
      if (table === 'archive.rooms') sql.provider.exec('CREATE TABLE archive.rooms (id TEXT)');
      sql.provider.exec(`INSERT INTO ${table} VALUES ('general')`);
      expect(sql.provider.exec(`SELECT * FROM ${table}`).toArray()).toEqual([{ id: 'general' }]);

      sql.provider.exec(
        `-- rooms get a topic\n/* default */ ALTER TABLE ${table} ADD COLUMN topic TEXT DEFAULT 'launch'`,
      );

      expect(sql.provider.exec(`SELECT * FROM ${table}`).toArray()).toEqual([
        { id: 'general', topic: 'launch' },
      ]);
    } finally {
      sql.close();
    }
  });

  it('runs a write that starts with many comments in linear time', () => {
    const sql = openSql();
    try {
      sql.provider.exec('CREATE TABLE rooms (id TEXT)');
      const started = performance.now();
      sql.provider.exec(`${'/* c */ '.repeat(10_000)}INSERT INTO rooms VALUES ('general')`);

      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      sql.close();
    }
  });

  it('gives a SELECT * the new columns after a batch that failed halfway', () => {
    const sql = openSql();
    try {
      sql.provider.exec('CREATE TEMP TABLE rooms (id TEXT)');
      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([]);

      expect(() =>
        sql.provider.exec(
          "DROP TABLE temp.rooms; CREATE TEMP TABLE rooms (id TEXT, topic TEXT); INSERT INTO temp.rooms VALUES ('general', 'launch'); INSERT INTO missing VALUES (1)",
        ),
      ).toThrow();

      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([
        { id: 'general', topic: 'launch' },
      ]);
    } finally {
      sql.close();
    }
  });

  it('reads a table that was dropped and made again with other columns', () => {
    const sql = openSql();
    try {
      sql.provider.exec('CREATE TABLE rooms (id TEXT)');
      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([]);

      sql.provider.exec('DROP TABLE rooms');
      sql.provider.exec('CREATE TABLE rooms (name TEXT, size INTEGER)');
      sql.provider.exec("INSERT INTO rooms VALUES ('general', 3)");

      expect(sql.provider.exec('SELECT * FROM rooms').toArray()).toEqual([
        { name: 'general', size: 3 },
      ]);
    } finally {
      sql.close();
    }
  });

  it('still runs a query after many other queries', () => {
    const sql = openSql();
    try {
      sql.provider.exec('CREATE TABLE rooms (id TEXT)');
      sql.provider.exec("INSERT INTO rooms VALUES ('general')");
      expect(sql.provider.exec('SELECT id FROM rooms').one()).toEqual({ id: 'general' });

      for (let i = 0; i < 300; i++) sql.provider.exec(`SELECT ${i} AS n FROM rooms`).one();

      expect(sql.provider.exec('SELECT id FROM rooms').one()).toEqual({ id: 'general' });
    } finally {
      sql.close();
    }
  });
});

describe.each(drivers)('createKv on %s', (_driver, openSql) => {
  it('supports values, prefix listing, deletion, and TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sql = openSql();
    try {
      const kv = createKv(sql.database!);
      await kv.set('room:one', { active: true });
      await kv.set('room:two', 'soon gone', { ttl: 1000 });
      await kv.set('user:one', 'other prefix');

      expect(await kv.get('room:one')).toEqual({ active: true });
      expect(await kv.list('room:')).toEqual(['room:one', 'room:two']);

      vi.advanceTimersByTime(1000);
      expect(await kv.get('room:two')).toBeUndefined();
      expect(await kv.list('room:')).toEqual(['room:one']);

      await kv.delete('room:one');
      expect(await kv.get('room:one')).toBeUndefined();
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('treats ttl zero as no expiry and reports the choice', async () => {
    const logger = createMockLogger();
    const sql = openSql();
    const kv = createKv(sql.database!, logger);

    try {
      await kv.set('key', 'value', { ttl: 0 });

      expect(await kv.get('key')).toBe('value');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ttl: 0'));
    } finally {
      sql.close();
    }
  });

  it('stores KV values in the same SQLite database as SQL', async () => {
    const sql = openSql();
    try {
      const kv = createKv(sql.database!);
      await kv.set('shared', { value: 1 });

      expect(
        sql.provider.exec<{ key: string }>('SELECT key FROM __livething_kv').toArray(),
      ).toEqual([{ key: 'shared' }]);
    } finally {
      sql.close();
    }
  });

  it('round-trips JavaScript number values that JSON would change', async () => {
    const sql = openSql();
    try {
      const kv = createKv(sql.database!);
      await kv.set('special-numbers', { nan: NaN, infinity: Infinity, negativeZero: -0 });

      const value = (await kv.get('special-numbers')) as {
        nan: number;
        infinity: number;
        negativeZero: number;
      };
      expect(Number.isNaN(value.nan)).toBe(true);
      expect(value.infinity).toBe(Infinity);
      expect(Object.is(value.negativeZero, -0)).toBe(true);
    } finally {
      sql.close();
    }
  });

  it('matches a prefix case-sensitively', async () => {
    const sql = openSql();
    try {
      const kv = createKv(sql.database!);
      await kv.set('Foo:one', 1);
      await kv.set('foo:two', 2);
      await kv.set('FOO:three', 3);

      expect(await kv.list('foo:')).toEqual(['foo:two']);
    } finally {
      sql.close();
    }
  });
});

describe('createTimers', () => {
  function storedAlarm(sql: SQLProvider): number | null {
    return (
      sql
        .exec<{
          timeMs: number;
        }>('SELECT time_ms AS timeMs FROM __livething_node_alarm WHERE id = 1')
        .one()?.timeMs ?? null
    );
  }

  it('persists an alarm and invokes the callback when it becomes due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});

      await timers.setAlarm(101_000);
      expect(storedAlarm(sql.provider)).toBe(101_000);
      await timers.start(onAlarm);

      await vi.advanceTimersByTimeAsync(999);
      expect(onAlarm).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(onAlarm).toHaveBeenCalledOnce();
      expect(storedAlarm(sql.provider)).toBeNull();
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('re-arms the current deadline when a later alarm replaces it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});

      await timers.start(onAlarm);
      await timers.setAlarm(201_000);
      await timers.setAlarm(202_000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(onAlarm).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onAlarm).toHaveBeenCalledOnce();
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('restores a persisted alarm when a new timer instance starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300_000);
    const sql = createSql();
    try {
      const first = createTimers(sql.provider);
      await first.setAlarm(301_000);
      first.stop();

      const second = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});
      await second.start(onAlarm);
      await vi.advanceTimersByTimeAsync(1000);

      expect(onAlarm).toHaveBeenCalledOnce();
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('stops an armed alarm without deleting its persisted deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(400_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});
      await timers.setAlarm(401_000);
      await timers.start(onAlarm);
      timers.stop();

      await vi.advanceTimersByTimeAsync(1000);

      expect(onAlarm).not.toHaveBeenCalled();
      expect(storedAlarm(sql.provider)).toBe(401_000);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('waits for an in-flight alarm before closing its storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    const runtime = createRuntime({});
    let release!: () => void;
    const alarmGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let alarmFinished = false;

    try {
      await runtime.timers.setAlarm(500_001);
      await runtime.timers.start(async () => {
        await alarmGate;
        runtime.storage.sql.exec('SELECT 1').one();
        alarmFinished = true;
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(alarmFinished).toBe(false);

      let shutdownFinished = false;
      const shutdown = runtime.close().then(() => {
        shutdownFinished = true;
      });

      await Promise.resolve();
      expect(shutdownFinished).toBe(false);

      release();
      await shutdown;
      expect(alarmFinished).toBe(true);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('runs an alarm that started before timers stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(600_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});
      await timers.setAlarm(600_001);
      await timers.start(onAlarm);

      vi.advanceTimersByTime(1);
      timers.stop();
      await timers.drain();

      expect(onAlarm).toHaveBeenCalledOnce();
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('cancels a re-armed timer after an engine alarm callback failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(700_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      await timers.setAlarm(700_001);
      await timers.start(async () => {
        await timers.setAlarm(800_000);
        throw new Error('alarm failed');
      });

      await vi.advanceTimersByTimeAsync(1);
      timers.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('retries after a transient failure acknowledging a due alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const sql = createSql();
    const logger = createMockLogger();

    try {
      const timers = createTimers(sql.provider, logger);
      const onAlarm = vi.fn(async () => {});

      await timers.setAlarm(101_000);
      await timers.start(onAlarm);

      sql.database!.exec(`
        CREATE TABLE alarm_failure_control (fail INTEGER NOT NULL);
        INSERT INTO alarm_failure_control (fail) VALUES (1);
        CREATE TRIGGER fail_alarm_delete
        BEFORE DELETE ON __livething_node_alarm
        WHEN (SELECT fail FROM alarm_failure_control) = 1
        BEGIN
          SELECT RAISE(ABORT, 'temporary alarm delete failure');
        END
      `);

      await vi.advanceTimersToNextTimerAsync();

      expect(logger.error).toHaveBeenCalledWith('[livething] Node durable alarm delivery failed', {
        error: 'temporary alarm delete failure',
      });
      expect(onAlarm).toHaveBeenCalledOnce();
      expect(storedAlarm(sql.provider)).toBe(101_000);

      sql.database!.prepare('UPDATE alarm_failure_control SET fail = 0').run();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(onAlarm).toHaveBeenCalledTimes(2);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('keeps a due alarm durable and retries when engine delivery rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const sql = createSql();
    const logger = createMockLogger();
    let failures = 1;

    const callback = vi.fn(async () => {
      if (failures-- > 0) throw new Error('retry was not persisted');
    });

    try {
      const timers = createTimers(sql.provider, logger);
      await timers.setAlarm(200_001);
      await timers.start(callback);

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();
      expect(storedAlarm(sql.provider)).toBe(200_001);

      await vi.advanceTimersByTimeAsync(2_000);

      expect(callback).toHaveBeenCalledTimes(2);
      expect(storedAlarm(sql.provider)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('[livething] Node durable alarm delivery failed', {
        error: 'retry was not persisted',
      });
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('retries a failed alarm at most six times with exponential backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(250_000);
    const sql = createSql();
    const callback = vi.fn(async () => {
      throw new Error('alarm keeps failing');
    });

    try {
      const timers = createTimers(sql.provider);
      await timers.setAlarm(250_001);
      await timers.start(callback);

      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledOnce();

      for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      expect(callback).toHaveBeenCalledTimes(7);
      expect(storedAlarm(sql.provider)).toBe(250_001);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('starts a fresh delivery retry budget for a replacement alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(275_000);
    const sql = createSql();
    const callback = vi.fn(async () => {
      throw new Error('alarm keeps failing');
    });

    try {
      const timers = createTimers(sql.provider);
      await timers.setAlarm(275_001);
      await timers.start(callback);

      await vi.advanceTimersByTimeAsync(1);
      for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      expect(callback).toHaveBeenCalledTimes(7);

      await timers.setAlarm(Date.now() + 1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(callback).toHaveBeenCalledTimes(9);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('does not acknowledge an alarm replacement written during delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {
        await timers.setAlarm(300_001);
        timers.stop();
      });

      await timers.setAlarm(300_001);
      await timers.start(onAlarm);
      await vi.advanceTimersByTimeAsync(1);

      expect(onAlarm).toHaveBeenCalledOnce();
      expect(storedAlarm(sql.provider)).toBe(300_001);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });

  it('does not run a replacement alarm while the current callback is still running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(400_000);
    const sql = createSql();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const timers = createTimers(sql.provider);
      let active = 0;
      let maxActive = 0;
      let markReplacementWritten!: () => void;
      const replacementWritten = new Promise<void>((resolve) => {
        markReplacementWritten = resolve;
      });

      const onAlarm = vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (onAlarm.mock.calls.length === 1) {
          await timers.setAlarm(Date.now());
          markReplacementWritten();
          await gate;
        }

        active -= 1;
      });

      await timers.setAlarm(400_001);
      await timers.start(onAlarm);
      await vi.advanceTimersByTimeAsync(1);
      await replacementWritten;
      await vi.advanceTimersByTimeAsync(1);

      expect(onAlarm).toHaveBeenCalledOnce();
      expect(maxActive).toBe(1);

      release();
      await timers.drain();
      await vi.runOnlyPendingTimersAsync();
      await timers.drain();

      expect(onAlarm).toHaveBeenCalledTimes(2);
      expect(maxActive).toBe(1);
    } finally {
      release?.();
      sql.close();
      vi.useRealTimers();
    }
  });
});

describe('createLogger and createPlatform', () => {
  it('maps structured logs to the Node console', () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createLogger();
      logger.info('info', { id: 'one' });
      logger.warn('warn');
      logger.error('error', { retry: true });

      expect(info).toHaveBeenCalledWith('info', { id: 'one' });
      expect(warn).toHaveBeenCalledWith('warn', {});
      expect(error).toHaveBeenCalledWith('error', { retry: true });
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('creates an adapter-owned platform context', () => {
    const platform = createPlatform();

    expect(platform).toEqual({});
  });
});

describe('createRuntime', () => {
  it('bundles the engine services and preserves injected storage providers', async () => {
    const kv = createFakeKv();
    const logger = createMockLogger();
    const runtime = createRuntime({ kv, logger });

    try {
      expect(runtime.platform).toEqual({});
      expect(runtime.storage.kv).toBe(kv);
      expect(runtime.storage.sql.limits.maxBoundParams).toBe(32_766);
      expect(runtime.logger).toBe(logger);
    } finally {
      await runtime.close();
    }
  });

  it('defaults KV to the same SQLite database as SQL', async () => {
    const runtime = createRuntime({});

    try {
      await runtime.storage.kv.set('default', 'sqlite-backed');

      expect(
        runtime.storage.sql
          .exec<{ key: string; value: string }>('SELECT key, value FROM __livething_kv')
          .toArray(),
      ).toEqual([{ key: 'default', value: expect.any(String) }]);
      expect(await runtime.storage.kv.get('default')).toBe('sqlite-backed');
    } finally {
      await runtime.close();
    }
  });
});

function createMockLogger() {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

function createFakeKv(): KVProvider {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
}

function createFakeSqlProvider(): SQLProvider {
  const limits: SqlLimits = {
    maxBoundParams: 1,
    maxStatementBytes: 1,
    maxValueBytes: 1,
  };

  const result: SqlResult = {
    toArray: () => [],
    one: () => null,
    raw: () => [],
  };

  return {
    exec<TRow = unknown>() {
      return result as SqlResult<TRow>;
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    limits,
  };
}
