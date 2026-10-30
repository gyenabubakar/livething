import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import {
  createEngineStorage,
  createEngineTimers,
  UserTransactionTracker,
} from '~/_engine/user-transaction.ts';
import { createTestSql, createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { emits } from '~/emits/emits.ts';
import { scheduled } from '~/scheduled/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function tracked(onRedoError: (error: unknown) => void = () => {}) {
  const queries: string[] = [];
  const raw = createTestSql({ onExec: (query) => queries.push(query.trim()) });
  raw.exec('CREATE TABLE user_rows (id INTEGER)');
  raw.exec('CREATE TABLE engine_rows (id INTEGER PRIMARY KEY)');
  const tracker = new UserTransactionTracker(onRedoError);

  const engine = createEngineStorage({ sql: raw, kv: undefined as never }, tracker).sql;

  function engineIds(): number[] {
    return raw
      .exec<{ id: number }>('SELECT id FROM engine_rows ORDER BY id')
      .toArray()
      .map((row) => row.id);
  }

  function userCount(): number {
    return raw.exec<{ c: number }>('SELECT COUNT(*) c FROM user_rows').one()!.c;
  }

  return { raw, tracker, engine, engineIds, userCount, queries };
}

describe('UserTransactionTracker', () => {
  it('keeps an engine write when the user transaction rolls back, and rolls back the user write', () => {
    const { raw, tracker, engine, engineIds, userCount } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        raw.exec('INSERT INTO user_rows VALUES (1)');
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(userCount()).toBe(0);
    expect(engineIds()).toEqual([1]);
  });

  it('does not run anything again when the user transaction commits', () => {
    const { raw, tracker, engine, engineIds, queries } = tracked();

    tracker.run(raw, () => {
      engine.exec('INSERT INTO engine_rows VALUES (1)');
    });

    expect(engineIds()).toEqual([1]);
    expect(queries.filter((query) => query.startsWith('INSERT INTO engine_rows'))).toHaveLength(1);
  });

  it('lets engine reads see engine writes made earlier in the same transaction', () => {
    const { raw, tracker, engine } = tracked();
    let seen: number[] = [];

    expect(() =>
      tracker.run(raw, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        seen = engine
          .exec<{ id: number }>('SELECT id FROM engine_rows')
          .toArray()
          .map((row) => row.id);
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(seen).toEqual([1]);
  });

  it('redoes writes in order', () => {
    const { raw, tracker, engine, engineIds } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        engine.exec('INSERT INTO engine_rows VALUES (2)');
        engine.exec('UPDATE engine_rows SET id = 3 WHERE id = 2');
        engine.exec('DELETE FROM engine_rows WHERE id = 1');
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(engineIds()).toEqual([3]);
  });

  it('does not redo an engine transaction that failed inside the user transaction', () => {
    const { raw, tracker, engine, engineIds } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        try {
          engine.transaction(() => {
            engine.exec('INSERT INTO engine_rows VALUES (2)');
            throw new Error('engine failed');
          });
        } catch {
          // the engine handles its own failure
        }

        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(engineIds()).toEqual([1]);
  });

  it('keeps an engine write of a rolled-back inner transaction when the outer commits', () => {
    const { raw, tracker, engine, engineIds, userCount } = tracked();

    tracker.run(raw, () => {
      try {
        tracker.run(raw, () => {
          raw.exec('INSERT INTO user_rows VALUES (1)');
          engine.exec('INSERT INTO engine_rows VALUES (1)');
          throw new Error('inner fails');
        });
      } catch {
        // the outer callback continues
      }
    });

    expect(userCount()).toBe(0);
    expect(engineIds()).toEqual([1]);
  });

  it('keeps an engine write once when the inner and the outer transactions both roll back', () => {
    const { raw, tracker, engine, engineIds } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        try {
          tracker.run(raw, () => {
            engine.exec('INSERT INTO engine_rows VALUES (1)');
            throw new Error('inner fails');
          });
        } catch {
          // the outer callback continues
        }

        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');

    expect(engineIds()).toEqual([1]);
  });

  it('keeps an engine write of a committed inner transaction when the outer rolls back', () => {
    const { raw, tracker, engine, engineIds } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        tracker.run(raw, () => {
          engine.exec('INSERT INTO engine_rows VALUES (1)');
        });
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');

    expect(engineIds()).toEqual([1]);
  });

  it('redoes the writes inside a transaction, so the rollback and the redo commit together', () => {
    const { raw, tracker, engine } = tracked();
    let depth = 0;
    let redoDepth = -1;
    const counted = {
      ...raw,
      exec<TRow = unknown>(query: string, ...params: unknown[]) {
        if (query.includes('VALUES (7)')) redoDepth = depth;

        return raw.exec<TRow>(query, ...params);
      },
      transaction<T>(fn: () => T): T {
        depth += 1;
        try {
          return raw.transaction(fn);
        } finally {
          depth -= 1;
        }
      },
    };

    expect(() =>
      tracker.run(counted, () => {
        engine.exec('INSERT INTO engine_rows VALUES (7)');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(redoDepth).toBe(1);
  });

  it('keeps an engine write when the commit itself fails after the callback returned', () => {
    const { raw, tracker, engine, engineIds } = tracked();
    raw.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    raw.exec(
      'CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)',
    );

    expect(() =>
      tracker.run(raw, () => {
        raw.exec('INSERT INTO child VALUES (99)');
        engine.exec('INSERT INTO engine_rows VALUES (1)');
      }),
    ).toThrow(/FOREIGN KEY/);

    expect(raw.exec('SELECT COUNT(*) c FROM child').one()).toEqual({ c: 0 });
    expect(engineIds()).toEqual([1]);
  });

  it('rethrows a value that is not an Error, unchanged', () => {
    const { raw, tracker, engine, engineIds } = tracked();
    const thrown = { code: 'nope' };
    let caught: unknown;

    try {
      tracker.run(raw, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        throw thrown;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    expect(engineIds()).toEqual([1]);
  });

  it('still throws the user error and keeps the other writes when the error handler throws', () => {
    const { raw, tracker, engine, engineIds } = tracked(() => {
      throw new Error('handler blew up');
    });
    const failsOnRedo = {
      ...raw,
      exec<TRow = unknown>(query: string, ...params: unknown[]) {
        if (query.includes('VALUES (2)')) throw new Error('one write failed');

        return raw.exec<TRow>(query, ...params);
      },
    };

    expect(() =>
      tracker.run(failsOnRedo, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        engine.exec('INSERT INTO engine_rows VALUES (2)');
        engine.exec('INSERT INTO engine_rows VALUES (3)');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(engineIds()).toEqual([1, 3]);
  });

  it('keeps 150,000 recorded writes of a committed inner transaction without overflowing the stack', () => {
    const { raw, tracker, engine } = tracked();

    tracker.run(raw, () => {
      tracker.run(raw, () => {
        for (let id = 0; id < 150_000; id += 1)
          engine.exec('INSERT INTO engine_rows VALUES (?)', id);
      });
    });

    expect(raw.exec('SELECT COUNT(*) c FROM engine_rows').one()).toEqual({ c: 150_000 });
  });

  it('keeps an engine write when the commit fails after the callback threw', () => {
    const { raw, tracker, engine, engineIds, userCount } = tracked();
    let outerCalls = 0;
    const failsFirstCommit = {
      ...raw,
      transaction<T>(fn: () => T): T {
        outerCalls += 1;
        if (outerCalls !== 1) return raw.transaction(fn);

        return raw.transaction(() => {
          fn();
          throw new Error('commit failed');
        });
      },
    };

    expect(() =>
      tracker.run(failsFirstCommit, () => {
        raw.exec('INSERT INTO user_rows VALUES (1)');
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(userCount()).toBe(0);
    expect(engineIds()).toEqual([1]);
  });

  describe('a statement that makes SQLite end the transaction itself', () => {
    function withCounter() {
      const setup = tracked();
      setup.raw.exec('CREATE TABLE counter (n INTEGER)');
      setup.raw.exec('INSERT INTO counter VALUES (0)');
      setup.raw.exec('CREATE TABLE unique_rows (id INTEGER PRIMARY KEY)');
      setup.raw.exec('INSERT INTO unique_rows VALUES (1)');

      function counter(): number {
        return setup.raw.exec<{ n: number }>('SELECT n FROM counter').one()!.n;
      }

      return { ...setup, counter };
    }

    it('redoes an engine write once, and throws the original error', () => {
      const { raw, tracker, engine, counter } = withCounter();

      expect(() =>
        tracker.run(raw, () => {
          engine.exec('UPDATE counter SET n = n + 1');
          raw.exec('INSERT OR ROLLBACK INTO unique_rows VALUES (1)');
        }),
      ).toThrow(/UNIQUE constraint failed/);

      expect(counter()).toBe(1);
    });

    it('redoes the engine writes of an inner and an outer transaction once each', () => {
      const { raw, tracker, engine, counter } = withCounter();

      expect(() =>
        tracker.run(raw, () => {
          engine.exec('UPDATE counter SET n = n + 10');
          try {
            tracker.run(raw, () => {
              engine.exec('UPDATE counter SET n = n + 1');
              raw.exec('INSERT OR ROLLBACK INTO unique_rows VALUES (1)');
            });
          } catch {
            // the outer callback continues, but SQLite has ended the whole transaction
          }
        }),
      ).toThrow();

      expect(counter()).toBe(11);
    });
  });

  describe('an engine transaction inside a user transaction', () => {
    function failingOnWriteThree() {
      const onRedoError = vi.fn();
      const setup = tracked(onRedoError);
      const failsOnRedo = {
        ...setup.raw,
        exec<TRow = unknown>(query: string, ...params: unknown[]) {
          if (query.includes('VALUES (3)')) throw new Error('write 3 failed');

          return setup.raw.exec<TRow>(query, ...params);
        },
      };

      return { ...setup, failsOnRedo, onRedoError };
    }

    it('is redone with all its writes when every write succeeds', () => {
      const { tracker, engine, engineIds, failsOnRedo, onRedoError } = failingOnWriteThree();

      expect(() =>
        tracker.run(failsOnRedo, () => {
          engine.exec('INSERT INTO engine_rows VALUES (10)');
          engine.transaction(() => {
            engine.exec('INSERT INTO engine_rows VALUES (1)');
            engine.exec('INSERT INTO engine_rows VALUES (2)');
          });
          engine.transaction(() => {
            engine.exec('INSERT INTO engine_rows VALUES (4)');
            engine.exec('INSERT INTO engine_rows VALUES (5)');
          });
          engine.exec('INSERT INTO engine_rows VALUES (6)');
          throw new Error('roll back');
        }),
      ).toThrow('roll back');

      expect(engineIds()).toEqual([1, 2, 4, 5, 6, 10]);
      expect(onRedoError).not.toHaveBeenCalled();
    });

    it('is redone all or nothing when one of its writes fails to redo', () => {
      const { tracker, engine, engineIds, failsOnRedo, onRedoError } = failingOnWriteThree();

      expect(() =>
        tracker.run(failsOnRedo, () => {
          engine.exec('INSERT INTO engine_rows VALUES (10)');
          engine.transaction(() => {
            engine.exec('INSERT INTO engine_rows VALUES (1)');
            engine.exec('INSERT INTO engine_rows VALUES (3)');
          });
          engine.exec('INSERT INTO engine_rows VALUES (6)');
          throw new Error('roll back');
        }),
      ).toThrow('roll back');

      expect(engineIds()).toEqual([6, 10]);
      expect(onRedoError).toHaveBeenCalledTimes(1);
    });

    it('is redone all or nothing when it holds another engine transaction', () => {
      const { tracker, engine, engineIds, failsOnRedo, onRedoError } = failingOnWriteThree();

      expect(() =>
        tracker.run(failsOnRedo, () => {
          engine.transaction(() => {
            engine.exec('INSERT INTO engine_rows VALUES (1)');
            engine.transaction(() => {
              engine.exec('INSERT INTO engine_rows VALUES (2)');
              engine.exec('INSERT INTO engine_rows VALUES (3)');
            });
          });
          engine.exec('INSERT INTO engine_rows VALUES (6)');
          throw new Error('roll back');
        }),
      ).toThrow('roll back');

      expect(engineIds()).toEqual([6]);
      expect(onRedoError).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the other writes when one write fails to redo', () => {
    const onRedoError = vi.fn();
    const { raw, tracker, engine, engineIds } = tracked(onRedoError);
    const failsOnRedo = {
      ...raw,
      exec<TRow = unknown>(query: string, ...params: unknown[]) {
        if (query.includes('VALUES (2)')) throw new Error('one write failed');

        return raw.exec<TRow>(query, ...params);
      },
    };

    expect(() =>
      tracker.run(failsOnRedo, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        engine.exec('INSERT INTO engine_rows VALUES (2)');
        engine.exec('INSERT INTO engine_rows VALUES (3)');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(engineIds()).toEqual([1, 3]);
    expect(onRedoError).toHaveBeenCalledTimes(1);
  });

  it('redoes a recorded operation, such as a kv write, after a rollback', () => {
    const { raw, tracker } = tracked();
    const redo = vi.fn();

    expect(() =>
      tracker.run(raw, () => {
        tracker.recordOperation(redo);
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('reports an operation whose promise rejects while it is redone', async () => {
    const onRedoError = vi.fn();
    const { raw, tracker } = tracked(onRedoError);

    expect(() =>
      tracker.run(raw, () => {
        tracker.recordOperation(() => Promise.reject(new Error('kv down')));
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    await Promise.resolve();

    expect(onRedoError).toHaveBeenCalledWith(expect.objectContaining({ message: 'kv down' }));
  });

  it('treats a PRAGMA that sets a value as a write and one that reads as a read', () => {
    const { raw, tracker, engine } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        engine.exec('PRAGMA user_version = 42');
        engine.exec('PRAGMA user_version');
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(raw.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 42 });
  });

  it('reports a redo that fails and still throws the user error', () => {
    const onRedoError = vi.fn();
    const { raw, tracker, engine } = tracked(onRedoError);
    let storageDown = false;
    const flaky = {
      ...raw,
      exec<TRow = unknown>(query: string, ...params: unknown[]) {
        if (storageDown) throw new Error('storage is down');

        return raw.exec<TRow>(query, ...params);
      },
    };

    expect(() =>
      tracker.run(flaky, () => {
        engine.exec('INSERT INTO engine_rows VALUES (1)');
        storageDown = true;
        throw new Error('roll back');
      }),
    ).toThrow('roll back');

    expect(onRedoError).toHaveBeenCalledTimes(1);
    expect(onRedoError.mock.calls[0]?.[0]).toMatchObject({ message: 'storage is down' });
  });

  it('does not record reads', () => {
    const { raw, tracker, engine, queries } = tracked();

    expect(() =>
      tracker.run(raw, () => {
        engine.exec('SELECT id FROM engine_rows');
        engine.exec('PRAGMA table_info(engine_rows)');
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(queries.filter((query) => query.startsWith('SELECT id FROM engine_rows'))).toHaveLength(
      1,
    );
  });

  it('records nothing outside a user transaction', () => {
    const { raw, tracker, engine, engineIds } = tracked();
    engine.exec('INSERT INTO engine_rows VALUES (1)');

    expect(() =>
      tracker.run(raw, () => {
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(engineIds()).toEqual([1]);
  });
});

describe('createEngineTimers', () => {
  function timersUnderTest() {
    const calls: string[] = [];
    const timers = {
      async setAlarm(timeMs: number) {
        calls.push(`set ${timeMs}`);
      },
      async deleteAlarm() {
        calls.push('delete');
      },
    };

    const raw = createTestSql();
    const tracker = new UserTransactionTracker(() => {});

    return { calls, raw, tracker, engineTimers: createEngineTimers(timers, tracker) };
  }

  it('sets an alarm again after a rollback, and deletes it again in order', () => {
    const { calls, raw, tracker, engineTimers } = timersUnderTest();

    expect(() =>
      tracker.run(raw, () => {
        void engineTimers.setAlarm(100);
        void engineTimers.deleteAlarm();
        void engineTimers.setAlarm(200);
        throw new Error('roll back');
      }),
    ).toThrow();

    expect(calls).toEqual(['set 100', 'delete', 'set 200', 'set 100', 'delete', 'set 200']);
  });

  it('does not report an alarm call that failed the first time as a failed redo', async () => {
    const errors: unknown[] = [];
    const timers = {
      async setAlarm() {
        throw new Error('alarm storage down');
      },
      async deleteAlarm() {
        throw new Error('alarm storage down');
      },
    };

    const raw = createTestSql();
    const tracker = new UserTransactionTracker((error) => errors.push(error));
    const engineTimers = createEngineTimers(timers, tracker);

    expect(() =>
      tracker.run(raw, () => {
        engineTimers.setAlarm(1).catch(() => {});
        engineTimers.deleteAlarm().catch(() => {});
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([]);
  });

  it('does not touch the alarm again when the transaction commits or there is none', () => {
    const { calls, raw, tracker, engineTimers } = timersUnderTest();

    void engineTimers.setAlarm(1);
    tracker.run(raw, () => {
      void engineTimers.setAlarm(2);
    });

    expect(calls).toEqual(['set 1', 'set 2']);
  });
});

function buildEngine(definition: ServerDefinition, storage = createTestStorage()) {
  let captured: Engine | undefined;
  adapter({
    id: 'user-transaction-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage,
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return { engine: captured, storage };
}

function frame(event: string): string {
  return JSON.stringify([event, {}, null]);
}

function open(engine: Engine, frames: string[] = []) {
  return engine.accept(Symbol('ws'), {
    send: (data: string) => frames.push(data),
    close() {},
    bufferedAmount: () => 0,
    userId: 'alice',
  } as never);
}

function deliverySeqs(frames: string[]): unknown[] {
  return frames.splice(0).map((raw) => JSON.parse(raw)[2]?.delivery?.seq);
}

describe('engine features inside a rolled-back user transaction', () => {
  function sequenceApp() {
    const base = server({
      capabilities: [sequence({ persist: true, batchSize: 1 }), emits({ note: t<{}>() })],
    });
    const rolledBack = base.on('rolled-back', {
      run(ctx) {
        ctx.sql.exec('CREATE TABLE IF NOT EXISTS marks (id INTEGER)');
        try {
          ctx.sql.transaction(() => {
            ctx.sql.exec('INSERT INTO marks VALUES (1)');
            ctx.send('note', {});
            ctx.send('note', {});
            ctx.send('note', {});
            throw new Error('roll back');
          });
        } catch {
          // continue
        }
      },
    });
    const plain = base.on('plain', {
      run(ctx) {
        ctx.send('note', {});
      },
    });
    return base.assemble({ handlers: [rolledBack, plain] });
  }

  it('never repeats a persisted sequence number, even after a restart', async () => {
    const storage = createTestStorage();
    const frames: string[] = [];
    const first = buildEngine(sequenceApp(), storage).engine;
    await first.initialize();
    const connection = open(first, frames);

    await connection.handleMessage(frame('rolled-back'));
    const insideTransaction = deliverySeqs(frames);
    await connection.handleMessage(frame('plain'));
    const afterTransaction = deliverySeqs(frames);

    const restarted = buildEngine(sequenceApp(), storage).engine;
    await restarted.initialize();
    await open(restarted, frames).handleMessage(frame('plain'));
    const afterRestart = deliverySeqs(frames);

    expect([...insideTransaction, ...afterTransaction, ...afterRestart]).toEqual([1, 2, 3, 4, 5]);
    expect(storage.sql.exec('SELECT COUNT(*) c FROM marks').one()).toEqual({ c: 0 });
  });

  it('keeps a scheduled task, and a cancel, that happened inside the transaction', async () => {
    const base = server({
      capabilities: [scheduled({ once: null, again: null, repeat: { every: 60_000 } })],
    });
    const onceTask = base.scheduled('once', { run() {} });
    const againTask = base.scheduled('again', { run() {} });
    const repeatTask = base.scheduled('repeat', { run() {} });
    const run = base.on('run', {
      run(ctx) {
        ctx.schedule('again', { time: Date.now() + 60_000 });
        try {
          ctx.sql.transaction(() => {
            ctx.schedule('once', { time: Date.now() + 60_000 });
            ctx.cancelScheduled('again');
            ctx.cancelScheduled('repeat');
            throw new Error('roll back');
          });
        } catch {
          // continue
        }
      },
    });

    const storage = createTestStorage();
    const { engine } = buildEngine(
      base.assemble({ handlers: [run, onceTask, againTask, repeatTask] }),
      storage,
    );
    await engine.initialize();
    await open(engine).handleMessage(frame('run'));

    const persisted = storage.sql
      .exec<{ taskId: string }>('SELECT taskId FROM __livething_scheduled ORDER BY taskId')
      .toArray()
      .map((row) => row.taskId);
    const stopped = storage.sql
      .exec<{ taskId: string }>('SELECT taskId FROM __livething_scheduled_stopped')
      .toArray()
      .map((row) => row.taskId);
    const inMemory = [...engine.core.scheduledRuns.values()].map((entry) => entry.taskId).sort();

    expect(persisted).toEqual(['once']);
    expect(inMemory).toEqual(persisted);
    expect(stopped).toEqual(['repeat']);
  });

  it('keeps a persistent tag added inside the transaction', async () => {
    const base = server({
      capabilities: [tags((_ephemeral, persistent) => [persistent('vip', t<string>())])],
    });
    const run = base.on('run', {
      run(ctx) {
        try {
          ctx.sql.transaction(() => {
            ctx.tags.persistent('vip').add('gold');
            throw new Error('roll back');
          });
        } catch {
          // continue
        }
      },
    });

    const storage = createTestStorage();
    const { engine } = buildEngine(base.assemble({ handlers: [run] }), storage);
    await engine.initialize();
    await open(engine).handleMessage(frame('run'));

    expect(storage.sql.exec('SELECT COUNT(*) c FROM __livething_tags').one()).toEqual({ c: 1 });
  });
});
