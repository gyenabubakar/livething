import { createTestSql } from '~/_test/sql.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapScheduledRuntime,
  cancelScheduledRuns,
  ensureScheduledSchema,
  handleScheduledAlarm,
  rescheduleScheduledAlarm,
  scheduleTaskRun,
} from './runtime.ts';
import type { ScheduledDeadLetter, ScheduledRun, ScheduledRuntimeAccess } from './types.ts';

function scheduledTableRows(sql: ReturnType<typeof createTestSql>): Record<string, unknown>[] {
  return sql
    .exec<
      Record<string, unknown>
    >('SELECT id, taskId, time, data, everyMs, attempts, recurring, retry FROM __wskit_scheduled')
    .toArray();
}

function createScheduledRuntime(
  tasks: Array<{
    taskId: string;
    options?: { every?: number; retry?: boolean | readonly number[] };
    hasData?: boolean;
    dataSchema?: unknown;
    handler?:
      | ((ctx: unknown) => void | Promise<void>)
      | ((ctx: unknown, data: unknown) => void | Promise<void>);
  }> = [],
) {
  const scheduledRuns = new Map<string, ScheduledRun>();
  const deadLetters = new Map<string, ScheduledDeadLetter>();
  const runsPersisted = new Map<string, string>();
  const dlqPersisted = new Map<string, string>();
  let idCounter = 0;
  const sql = createTestSql();
  const timers = {
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
    getAlarm: vi.fn(async () => null),
  };

  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));

  const runtime: ScheduledRuntimeAccess & { alarms: number } = {
    alarms: 0,
    requireStorage: () => ({
      sql,
      kv: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
    }),
    getTimers: () => timers,
    generateId: () => `task_${++idCounter}`,
    getScheduledRuns: () => scheduledRuns,
    getScheduledDlq: () => deadLetters,
    getScheduledRunsPersisted: () => runsPersisted,
    getScheduledDlqPersisted: () => dlqPersisted,
    getScheduledTask: (taskId) => taskMap.get(taskId) as never,
    getScheduledTasks: () => taskMap.values() as never,
    createTaskContext: () => ({ ok: true }),
    rescheduleAlarm: () => {
      runtime.alarms += 1;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  ensureScheduledSchema(runtime);

  return { runtime, scheduledRuns, deadLetters, sql, timers };
}

describe('scheduled/runtime', () => {
  it('bootstraps scheduler state and ensures recurring baseline runs exist', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'flush', options: { every: 1_000 } },
    ]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);

    bootstrapScheduledRuntime(runtime);

    expect([...scheduledRuns.values()]).toHaveLength(1);
    expect([...scheduledRuns.values()][0]).toMatchObject({
      taskId: 'flush',
      time: 11_000,
      recurring: true,
      attempts: 0,
    });
    expect(runtime.alarms).toBe(1);
    now.mockRestore();
  });

  it('drops persisted runs whose taskId is no longer registered at boot', () => {
    // A previous deploy registered a recurring `cleanup` task and persisted
    // its row to `__wskit_scheduled`. The new deploy removes the task. Boot
    // must drop the orphan row instead of restoring it — otherwise every
    // alarm tick would skip the missing handler and re-queue the same row
    // for the next interval, leaving storage to grow forever.
    const { runtime, scheduledRuns, sql } = createScheduledRuntime([]);
    sql.exec(
      `INSERT INTO __wskit_scheduled (id, taskId, time, data, everyMs, attempts, recurring, retry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'task_orphan_1',
      'cleanup',
      5_000,
      null,
      60_000,
      0,
      1,
      1,
    );

    bootstrapScheduledRuntime(runtime);

    expect([...scheduledRuns.values()]).toHaveLength(0);
    expect(scheduledTableRows(sql)).toHaveLength(0);
  });

  it('does not re-queue a recurring run whose task disappeared between alarm ticks', async () => {
    // Same orphan scenario, but the row makes it past boot (e.g. the
    // current process started with the task registered, and a hot-swap or
    // race removed it before this alarm fires). The success branch must
    // refuse to re-queue the recurring run when the task is gone.
    const { runtime, scheduledRuns } = createScheduledRuntime([]);
    scheduledRuns.set('task_orphan_1', {
      id: 'task_orphan_1',
      taskId: 'cleanup',
      time: 1,
      data: undefined,
      every: 60_000,
      attempts: 0,
      recurring: true,
      retry: true,
    });

    await handleScheduledAlarm(runtime);

    expect([...scheduledRuns.values()]).toHaveLength(0);
  });

  it('queues one-shot runs and cancels matching queued runs', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'flush', hasData: true, dataSchema: (value: unknown) => value },
    ]);

    scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { id: 'a' } });
    scheduleTaskRun(runtime, { taskId: 'flush', time: 200, data: { id: 'b' } });
    cancelScheduledRuns(runtime, 'flush', { id: 'a' });

    expect([...scheduledRuns.values()]).toHaveLength(1);
    expect([...scheduledRuns.values()][0]?.data).toEqual({ id: 'b' });
  });

  it('invokes no-data tasks with only ctx', async () => {
    const handler = vi.fn(async () => {});
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush', handler }]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);

    scheduledRuns.set('run_1', {
      id: 'run_1',
      taskId: 'flush',
      time: 0,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: true,
    });

    await handleScheduledAlarm(runtime);

    expect(handler).toHaveBeenCalledWith({ ok: true });
    expect(handler.mock.calls[0]).toHaveLength(1);
    now.mockRestore();
  });

  it('invokes data-backed tasks with validated data', async () => {
    const handler = vi.fn(async () => {});
    const { runtime, scheduledRuns } = createScheduledRuntime([
      {
        taskId: 'flush',
        hasData: true,
        dataSchema: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
        handler,
      },
    ]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);

    scheduleTaskRun(runtime, { taskId: 'flush', time: 50, data: { count: '5' } });
    const run = [...scheduledRuns.values()][0]!;
    expect(run.data).toEqual({ count: 5 });

    await handleScheduledAlarm(runtime);

    expect(handler).toHaveBeenCalledWith({ ok: true }, { count: 5 });
    now.mockRestore();
  });

  it('throws when data is queued for a task without .data(...)', () => {
    const { runtime } = createScheduledRuntime([{ taskId: 'flush' }]);

    expect(() =>
      scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { nope: true } }),
    ).toThrow(/does not declare \.data/);
  });

  it('throws synchronously when scheduling an unregistered task id', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    expect(() =>
      scheduleTaskRun(runtime, { taskId: 'typo-flush', time: 100, data: undefined }),
    ).toThrow(/scheduled task "typo-flush" is not registered/);
    expect([...scheduledRuns.values()].map((r) => r.taskId)).not.toContain('typo-flush');
  });

  it('rejects non-finite, non-integer, zero, and negative times', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
      1.5,
    ]) {
      expect(() =>
        scheduleTaskRun(runtime, { taskId: 'flush', time: bad, data: undefined }),
      ).toThrow(/must be a positive safe integer/);
    }
    expect([...scheduledRuns.values()]).toHaveLength(0);
  });

  it('throws when task data is missing or fails validation at enqueue time', () => {
    const { runtime } = createScheduledRuntime([
      {
        taskId: 'flush',
        hasData: true,
        dataSchema: v.object({ label: v.string() }),
      },
    ]);

    expect(() =>
      scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: undefined }),
    ).toThrow();
    expect(() =>
      scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { label: 42 } }),
    ).toThrow();
  });

  it('multi-key filter cancels only runs matching every key (AND semantics)', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'flush', hasData: true, dataSchema: (value: unknown) => value },
    ]);

    scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { label: 'drop', tier: 'gold' } });
    scheduleTaskRun(runtime, {
      taskId: 'flush',
      time: 200,
      data: { label: 'drop', tier: 'silver' },
    });
    scheduleTaskRun(runtime, { taskId: 'flush', time: 300, data: { label: 'keep', tier: 'gold' } });

    cancelScheduledRuns(runtime, 'flush', { label: 'drop', tier: 'gold' });

    const survivors = [...scheduledRuns.values()].map((run) => run.data);
    expect(survivors).toHaveLength(2);
    expect(survivors).toEqual(
      expect.arrayContaining([
        { label: 'drop', tier: 'silver' },
        { label: 'keep', tier: 'gold' },
      ]),
    );
  });

  it('filter with a key missing from the run data does not match', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'flush', hasData: true, dataSchema: (value: unknown) => value },
    ]);

    scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { id: 'a' } });
    cancelScheduledRuns(runtime, 'flush', { id: 'a', doesNotExist: 'x' });

    expect(scheduledRuns.size).toBe(1);
  });

  it('filter with a key that does not exist on any run is a no-op', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'flush', hasData: true, dataSchema: (value: unknown) => value },
    ]);

    scheduleTaskRun(runtime, { taskId: 'flush', time: 100, data: { id: 'a' } });
    scheduleTaskRun(runtime, { taskId: 'flush', time: 200, data: { id: 'b' } });
    cancelScheduledRuns(runtime, 'flush', { __never: '__never' });

    expect(scheduledRuns.size).toBe(2);
  });

  it('filtered cancel on a recurring task does not remove the recurring baseline run', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'tick', options: { every: 1_000 } },
    ]);

    bootstrapScheduledRuntime(runtime);

    const before = [...scheduledRuns.values()];
    expect(before).toHaveLength(1);
    expect(before[0]?.recurring).toBe(true);

    cancelScheduledRuns(runtime, 'tick', { any: 'filter' });

    expect(scheduledRuns.size).toBe(1);
    expect([...scheduledRuns.values()][0]?.recurring).toBe(true);
  });

  it('retries failures with backoff and dead-letters exhausted runs', async () => {
    const handler = vi
      .fn<(_: unknown, __: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockRejectedValueOnce(new Error('fourth'));
    const { runtime, scheduledRuns, deadLetters } = createScheduledRuntime([
      { taskId: 'flush', handler },
    ]);
    const now = vi.spyOn(Date, 'now');

    scheduledRuns.set('run_1', {
      id: 'run_1',
      taskId: 'flush',
      time: 0,
      data: { force: true },
      attempts: 0,
      recurring: false,
      retry: true,
    });

    now.mockReturnValue(1_000);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run_1')?.time).toBe(2_000);
    expect(scheduledRuns.get('run_1')?.attempts).toBe(1);

    now.mockReturnValue(2_000);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run_1')?.time).toBe(7_000);
    expect(scheduledRuns.get('run_1')?.attempts).toBe(2);

    now.mockReturnValue(7_000);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run_1')?.time).toBe(32_000);
    expect(scheduledRuns.get('run_1')?.attempts).toBe(3);

    now.mockReturnValue(32_000);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.has('run_1')).toBe(false);
    expect(deadLetters.get('run_1')).toMatchObject({
      taskId: 'flush',
      attempts: 4,
      error: { message: 'fourth', name: 'Error' },
    });
    now.mockRestore();
  });

  it('clears the native alarm when the scheduled queue empties', () => {
    const deleteAlarm = vi.fn(async () => {});
    const runtime = {
      getScheduledRuns: () => new Map<string, ScheduledRun>(),
      timers: {
        setAlarm: vi.fn(async () => {}),
        deleteAlarm,
      },
      getTimers() {
        return this.timers;
      },
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };

    rescheduleScheduledAlarm(runtime);

    // Native durable alarms (e.g. CF DOs) must be cleared too — otherwise
    // the platform wakes the DO at the previously-set time and finds
    // nothing scheduled, billing for a wake that does no work.
    expect(deleteAlarm).toHaveBeenCalledTimes(1);
  });

  it('skips deleteAlarm when the adapter does not provide it', () => {
    const runtime = {
      getScheduledRuns: () => new Map<string, ScheduledRun>(),
      getTimers: () => undefined,
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };

    expect(() => rescheduleScheduledAlarm(runtime)).not.toThrow();
  });

  it('uses timer alarms when available and falls back to timeouts otherwise', () => {
    const withAlarm = {
      getScheduledRuns: () =>
        new Map<string, ScheduledRun>([
          [
            'a',
            {
              id: 'a',
              taskId: 'flush',
              time: 500,
              data: undefined,
              attempts: 0,
              recurring: false,
              retry: true,
            },
          ],
        ]),
      timers: {
        setAlarm: vi.fn(async () => {}),
      },
      getTimers() {
        return this.timers;
      },
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };

    rescheduleScheduledAlarm(withAlarm);
    expect(withAlarm.timers.setAlarm).toHaveBeenCalled();

    const timeoutCallback = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      timeoutCallback.mockImplementation(callback as () => void);
      return 'timeout-1' as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const withoutAlarm = {
      getScheduledRuns: () =>
        new Map<string, ScheduledRun>([
          [
            'a',
            {
              id: 'a',
              taskId: 'flush',
              time: 500,
              data: undefined,
              attempts: 0,
              recurring: false,
              retry: true,
            },
          ],
        ]),
      getTimers: () => undefined,
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(250);

    rescheduleScheduledAlarm(withoutAlarm);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);
    now.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('retries with custom backoff schedule and dead-letters after exhausting it', async () => {
    const handler = vi
      .fn<(_: unknown, __: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockRejectedValueOnce(new Error('fail-3'));
    const { runtime, scheduledRuns, deadLetters } = createScheduledRuntime([
      { taskId: 'quick', handler, options: { retry: [10, 20] } },
    ]);
    const now = vi.spyOn(Date, 'now');

    scheduledRuns.set('run_1', {
      id: 'run_1',
      taskId: 'quick',
      time: 0,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: [10, 20],
    });

    now.mockReturnValue(100);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run_1')?.time).toBe(110);
    expect(scheduledRuns.get('run_1')?.attempts).toBe(1);

    now.mockReturnValue(110);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run_1')?.time).toBe(130);
    expect(scheduledRuns.get('run_1')?.attempts).toBe(2);

    now.mockReturnValue(130);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.has('run_1')).toBe(false);
    expect(deadLetters.get('run_1')).toMatchObject({
      taskId: 'quick',
      attempts: 3,
      error: { message: 'fail-3' },
    });
    now.mockRestore();
  });

  it('recurring task with retry:false dead-letters every fire and re-queues the next tick', async () => {
    const handler = vi
      .fn<(_: unknown, __: unknown) => Promise<void>>()
      .mockRejectedValue(new Error('always fails'));
    const { runtime, scheduledRuns, deadLetters } = createScheduledRuntime([
      { taskId: 'tick', handler, options: { every: 100, retry: false } },
    ]);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(0);
    bootstrapScheduledRuntime(runtime);

    let recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();

    now.mockReturnValue(100);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(1);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(200);

    now.mockReturnValue(200);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(2);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(300);

    now.mockReturnValue(300);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(3);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(400);

    expect(handler).toHaveBeenCalledTimes(3);

    now.mockRestore();
  });

  it('one-shot task with retry:false dead-letters immediately without re-queuing', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const { runtime, scheduledRuns, deadLetters } = createScheduledRuntime([
      { taskId: 'oneshot', handler, options: { retry: false } },
    ]);
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);

    scheduledRuns.set('run_1', {
      id: 'run_1',
      taskId: 'oneshot',
      time: 0,
      data: { x: 1 },
      attempts: 0,
      recurring: false,
      retry: false,
    });

    await handleScheduledAlarm(runtime);

    expect(deadLetters.get('run_1')).toMatchObject({
      taskId: 'oneshot',
      attempts: 1,
      error: { message: 'boom' },
    });
    expect(scheduledRuns.has('run_1')).toBe(false);
    expect([...scheduledRuns.values()]).toHaveLength(0);

    now.mockRestore();
  });

  it('round-trips custom backoff through serialization', () => {
    const { runtime, scheduledRuns, sql } = createScheduledRuntime([
      { taskId: 'ser', options: { retry: [100, 200] } },
    ]);

    scheduleTaskRun(runtime, { taskId: 'ser', time: 500, data: undefined });
    expect(scheduledTableRows(sql)[0]?.retry).toBe('[100,200]');

    // Drop the in-memory copy and re-read the persisted row: deserialization must
    // turn the stored '[100,200]' string back into a real backoff array.
    scheduledRuns.clear();
    bootstrapScheduledRuntime(runtime);

    const restored = [...scheduledRuns.values()].find((r) => r.taskId === 'ser');
    expect(restored?.retry).toEqual([100, 200]);
  });

  it('dead-letters a task whose rejected value cannot be JSON-stringified', async () => {
    // A handler that throws a BigInt would have crashed the alarm path
    // before — JSON.stringify(1n) throws TypeError. The run is already
    // gone from the queue at that point, so the failed task would
    // disappear with no dead-letter record.
    const handler = vi
      .fn<(_: unknown, __: unknown) => Promise<void>>()
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      .mockImplementation(async () => {
        throw 1n;
      });
    const { runtime, scheduledRuns, deadLetters } = createScheduledRuntime([
      { taskId: 'bigint-thrower', handler, options: { retry: false } },
    ]);
    const now = vi.spyOn(Date, 'now');

    scheduledRuns.set('run_1', {
      id: 'run_1',
      taskId: 'bigint-thrower',
      time: 0,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: false,
    });

    now.mockReturnValue(50);
    await expect(handleScheduledAlarm(runtime)).resolves.toBeUndefined();

    expect(scheduledRuns.has('run_1')).toBe(false);
    const dlq = deadLetters.get('run_1');
    expect(dlq).toBeDefined();
    expect(typeof dlq!.error.message).toBe('string');
    expect(dlq!.error.message).toBe('1');
    now.mockRestore();
  });
});
