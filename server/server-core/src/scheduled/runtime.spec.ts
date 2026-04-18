import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapScheduledRuntime,
  cancelScheduledRuns,
  handleScheduledAlarm,
  rescheduleScheduledAlarm,
  scheduleTaskRun,
} from './runtime.ts';
import type { ScheduledDeadLetter, ScheduledRun, ScheduledRuntimeAccess } from './types.ts';

class FakeSqlResult {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  toArray(): Record<string, unknown>[] {
    return [...this.rows];
  }

  one(): Record<string, unknown> | null {
    return this.rows[0] ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row));
  }
}

function createScheduledRuntime(
  tasks: Array<{
    taskId: string;
    options?: { every?: number; retry?: boolean | readonly number[] };
    handler?: (ctx: unknown, data: unknown) => void | Promise<void>;
  }> = [],
) {
  const scheduledRuns = new Map<string, ScheduledRun>();
  const deadLetters = new Map<string, ScheduledDeadLetter>();
  let idCounter = 0;
  const storageRows = {
    scheduled: [] as Record<string, unknown>[],
    dlq: [] as Record<string, unknown>[],
  };
  const timers = {
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
    getAlarm: vi.fn(async () => null),
    setTimeout: vi.fn((callback: () => void) => callback),
    clearTimeout: vi.fn(),
  };

  function exec(query: string, ...params: unknown[]) {
    const normalized = query.replaceAll(/\s+/g, ' ').trim();

    if (
      normalized.startsWith(
        'SELECT id, taskId, time, data, everyMs, attempts, recurring, retry FROM _wskit_scheduled',
      )
    ) {
      return new FakeSqlResult(storageRows.scheduled);
    }

    if (
      normalized.startsWith(
        'SELECT id, taskId, time, failedAt, data, attempts, error FROM _wskit_scheduled_dlq',
      )
    ) {
      return new FakeSqlResult(storageRows.dlq);
    }

    if (normalized.startsWith('DELETE FROM _wskit_scheduled_dlq')) {
      storageRows.dlq = [];
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('DELETE FROM _wskit_scheduled')) {
      storageRows.scheduled = [];
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('INSERT INTO _wskit_scheduled_dlq')) {
      const [id, taskId, time, failedAt, data, attempts, error] = params;
      storageRows.dlq.push({
        id,
        taskId,
        time,
        failedAt,
        data,
        attempts,
        error,
      });
      return new FakeSqlResult([]);
    }

    if (normalized.startsWith('INSERT INTO _wskit_scheduled')) {
      const [id, taskId, time, data, everyMs, attempts, recurring, retry] = params;
      storageRows.scheduled.push({
        id,
        taskId,
        time,
        data,
        everyMs,
        attempts,
        recurring,
        retry,
      });
      return new FakeSqlResult([]);
    }

    return new FakeSqlResult([]);
  }
  const sql = {
    exec,
    transaction<T>(fn: (tx: { exec: typeof exec }) => T): T {
      return fn({ exec });
    },
  };

  const taskMap = new Map(tasks.map((task) => [task.taskId, task]));

  const runtime: ScheduledRuntimeAccess & {
    storageRows: typeof storageRows;
    alarms: number;
  } = {
    storageRows,
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
    requireTimers: () => timers,
    generateId: () => `task_${++idCounter}`,
    getScheduledRuns: () => scheduledRuns,
    getScheduledDlq: () => deadLetters,
    getScheduledTask: (taskId) => taskMap.get(taskId) as never,
    getScheduledTasks: () => taskMap.values() as never,
    createTaskContext: () => ({ ok: true }),
    rescheduleAlarm: () => {
      runtime.alarms += 1;
    },
  };

  return { runtime, scheduledRuns, deadLetters, storageRows, timers };
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

  it('queues one-shot runs and cancels matching queued runs', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    scheduleTaskRun(runtime, 'flush', 100, { id: 'a' });
    scheduleTaskRun(runtime, 'flush', 200, { id: 'b' });
    cancelScheduledRuns(runtime, 'flush', { id: 'a' });

    expect([...scheduledRuns.values()]).toHaveLength(1);
    expect([...scheduledRuns.values()][0]?.data).toEqual({ id: 'b' });
  });

  it('multi-key filter cancels only runs matching every key (AND semantics)', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    scheduleTaskRun(runtime, 'flush', 100, { label: 'drop', tier: 'gold' });
    scheduleTaskRun(runtime, 'flush', 200, { label: 'drop', tier: 'silver' });
    scheduleTaskRun(runtime, 'flush', 300, { label: 'keep', tier: 'gold' });

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
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    scheduleTaskRun(runtime, 'flush', 100, { id: 'a' });
    cancelScheduledRuns(runtime, 'flush', { id: 'a', doesNotExist: 'x' });

    expect(scheduledRuns.size).toBe(1);
  });

  it('filter with a key that does not exist on any run is a no-op', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([{ taskId: 'flush' }]);

    scheduleTaskRun(runtime, 'flush', 100, { id: 'a' });
    scheduleTaskRun(runtime, 'flush', 200, { id: 'b' });
    cancelScheduledRuns(runtime, 'flush', { __never: '__never' });

    expect(scheduledRuns.size).toBe(2);
  });

  it('filtered cancel on a recurring task does not remove the recurring baseline run', () => {
    const { runtime, scheduledRuns } = createScheduledRuntime([
      { taskId: 'tick', options: { every: 1_000 } },
    ]);

    bootstrapScheduledRuntime(runtime);

    // Bootstrap seeds the recurring baseline.
    const before = [...scheduledRuns.values()];
    expect(before).toHaveLength(1);
    expect(before[0]?.recurring).toBe(true);

    cancelScheduledRuns(runtime, 'tick', { any: 'filter' });

    // Filter is ignored for recurring runs — baseline survives.
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
        setTimeout: vi.fn(),
        clearTimeout: vi.fn(),
      },
      requireTimers() {
        return this.timers;
      },
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };

    rescheduleScheduledAlarm(withAlarm);
    expect(withAlarm.timers.setAlarm).toHaveBeenCalled();

    const timeoutCallback = vi.fn();
    const withoutAlarmTimers = {
      setTimeout: vi.fn((callback: () => void) => {
        timeoutCallback.mockImplementation(callback);
        return 'timeout-1';
      }),
      clearTimeout: vi.fn(),
    };
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
      requireTimers: () => withoutAlarmTimers,
      getAlarmHandle: () => null,
      setAlarmHandle: vi.fn(),
      onAlarm: vi.fn(async () => {}),
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(250);

    rescheduleScheduledAlarm(withoutAlarm);

    expect(withoutAlarmTimers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    now.mockRestore();
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

    // Bootstrap seeds a recurring run at 100.
    let recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();

    // Fire 1.
    now.mockReturnValue(100);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(1);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(200);

    // Fire 2.
    now.mockReturnValue(200);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(2);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(300);

    // Fire 3.
    now.mockReturnValue(300);
    await handleScheduledAlarm(runtime);
    expect(deadLetters.size).toBe(3);

    recurring = [...scheduledRuns.values()].find((r) => r.recurring);
    expect(recurring).toBeDefined();
    expect(recurring?.time).toBe(400);

    expect(handler).toHaveBeenCalledTimes(3);

    now.mockRestore();
  });

  it('round-trips custom backoff through serialization', () => {
    const { runtime, scheduledRuns, storageRows } = createScheduledRuntime([
      { taskId: 'ser', options: { retry: [100, 200] } },
    ]);

    scheduleTaskRun(runtime, 'ser', 500, undefined);
    const serialized = storageRows.scheduled[0];
    expect(serialized?.retry).toBe('[100,200]');

    scheduledRuns.clear();
    storageRows.scheduled[0] = {
      ...serialized!,
      retry: '[100,200]',
    };
    bootstrapScheduledRuntime(runtime);

    const restored = [...scheduledRuns.values()].find((r) => r.taskId === 'ser');
    expect(restored?.retry).toEqual([100, 200]);
  });
});
