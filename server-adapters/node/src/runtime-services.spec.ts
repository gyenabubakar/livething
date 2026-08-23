import { describe, expect, it, vi } from 'vitest';
import type { KVProvider, Logger, SqlLimits, SQLProvider, SqlResult } from '@wskit/server/adapters';
import type { Server } from 'node:http';
import { createAsyncContext } from './async-context.ts';
import { createLogger } from './logger.ts';
import { createPlatform } from './platform.ts';
import { createKv } from './providers/kv.ts';
import { createSql } from './providers/sql.ts';
import { createTimers } from './providers/timers.ts';
import { createRuntime } from './runtime.ts';
import { createWaitUntil } from './wait-until.ts';

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

describe('createSql', () => {
  it('runs real SQLite reads, writes, raw results, and schema batches', () => {
    const runtime = createSql();
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
    const runtime = createSql();
    try {
      runtime.provider.exec('CREATE TABLE values_table (value TEXT)');

      expect(() =>
        runtime.provider.transaction((tx) => {
          tx.exec('INSERT INTO values_table (value) VALUES (?)', 'kept out');
          throw new Error('stop');
        }),
      ).toThrow('stop');

      expect(runtime.provider.exec('SELECT value FROM values_table').toArray()).toEqual([]);
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
});

describe('createKv', () => {
  it('supports values, prefix listing, deletion, and TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const sql = createSql();
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
    const sql = createSql();
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
    const sql = createSql();
    try {
      const kv = createKv(sql.database!);
      await kv.set('shared', { value: 1 });

      expect(sql.provider.exec<{ key: string }>('SELECT key FROM __wskit_kv').toArray()).toEqual([
        { key: 'shared' },
      ]);
    } finally {
      sql.close();
    }
  });
});

describe('createTimers', () => {
  it('persists an alarm and invokes the callback when it becomes due', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const sql = createSql();
    try {
      const timers = createTimers(sql.provider);
      const onAlarm = vi.fn(async () => {});

      await timers.setAlarm(101_000);
      expect(await timers.getAlarm()).toBe(101_000);
      await timers.start(onAlarm);

      await vi.advanceTimersByTimeAsync(999);
      expect(onAlarm).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(onAlarm).toHaveBeenCalledOnce();
      expect(await timers.getAlarm()).toBeNull();
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
      expect(await timers.getAlarm()).toBe(401_000);
    } finally {
      sql.close();
      vi.useRealTimers();
    }
  });
});

describe('createWaitUntil', () => {
  it('waits for tracked background work and logs rejected work', async () => {
    let resolveTask!: () => void;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const logger = createMockLogger();
    const waitUntil = createWaitUntil(logger);

    waitUntil.waitUntil(task);
    let drained = false;
    const drain = waitUntil.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveTask();
    await drain;
    expect(drained).toBe(true);

    waitUntil.waitUntil(Promise.reject(new Error('background failed')));
    await waitUntil.drain();
    expect(logger.error).toHaveBeenCalledWith('[wskit] waitUntil task failed', {
      error: 'background failed',
    });
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

  it('exposes the Node HTTP server and environment as platform context', () => {
    const server = {} as Server;
    const env = { NODE_ENV: 'test' };
    const platform = createPlatform(server, env);

    expect(platform).toEqual({ server, env });
  });
});

describe('createRuntime', () => {
  it('bundles the engine services and preserves injected storage providers', async () => {
    const server = {} as Server;
    const env = { NODE_ENV: 'test' };
    const kv = createFakeKv();
    const logger = createMockLogger();
    const runtime = createRuntime({ server, env, kv, logger });

    try {
      expect(runtime.env).toBe(env);
      expect(runtime.platform).toEqual({ server, env });
      expect(runtime.storage.kv).toBe(kv);
      expect(runtime.storage.sql.limits.maxBoundParams).toBe(32_766);
      expect(runtime.asyncContextFactory().getStore()).toBeUndefined();
      expect(runtime.logger).toBe(logger);
    } finally {
      await runtime.close();
    }
  });

  it('defaults KV to the same SQLite database as SQL', async () => {
    const runtime = createRuntime({ server: {} as Server, env: {} });

    try {
      await runtime.storage.kv.set('default', 'sqlite-backed');

      expect(
        runtime.storage.sql
          .exec<{ key: string; value: string }>('SELECT key, value FROM __wskit_kv')
          .toArray(),
      ).toEqual([{ key: 'default', value: '"sqlite-backed"' }]);
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
    transaction<T>(fn: (tx: { exec<TRow = unknown>(): SqlResult<TRow> }) => T): T {
      return fn({
        exec<TRow = unknown>() {
          return result as SqlResult<TRow>;
        },
      });
    },
    limits,
  };
}
