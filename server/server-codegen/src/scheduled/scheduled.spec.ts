import { t } from '~/t.ts';
import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from './runtime.mocks.ts';
import {
  bootstrapScheduledRuntime,
  cancelScheduledRuns,
  handleScheduledAlarm,
  scheduleTaskRun,
} from './runtime.ts';
import { scheduled } from './scheduled.ts';

describe('scheduled()', () => {
  it('stores the handler form', () => {
    async function cleanup() {}

    const task = scheduled('cleanup', cleanup, { every: 60_000 });

    expect(task.taskId).toBe('cleanup');
    expect(task.handler).toBe(cleanup);
    expect(task.options?.every).toBe(60_000);
    expect(task.__requires.timers).toBe(true);
  });

  it('supports the type-only form', () => {
    const task = scheduled('cleanup', t<{ roomId: string }>());

    expect(task.taskId).toBe('cleanup');
    expect(task.handler).toBeUndefined();
    expect('data' in task).toBe(true);
  });

  it('bootstraps tables, restores saved state, and creates missing recurring baseline runs', () => {
    const flush = scheduled('flush', async () => {}, { every: 1_000 });
    const cleanup = scheduled('cleanup', async () => {}, { retry: false });
    const { runtime, sql, scheduledRuns, scheduledDlq, getRescheduleCount } = createRuntime([
      flush,
      cleanup,
    ]);

    sql.scheduled.set('saved-run', {
      id: 'saved-run',
      taskId: 'cleanup',
      time: 500,
      data: JSON.stringify({ roomId: 'r1' }),
      everyMs: null,
      attempts: 2,
      recurring: 0,
      retry: 0,
    });
    sql.scheduledDlq.set('saved-dlq', {
      id: 'saved-dlq',
      taskId: 'cleanup',
      time: 100,
      failedAt: 200,
      data: JSON.stringify({ roomId: 'r1' }),
      attempts: 4,
      error: JSON.stringify({ message: 'boom' }),
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    bootstrapScheduledRuntime(runtime);
    nowSpy.mockRestore();

    expect(scheduledRuns.get('saved-run')).toMatchObject({
      taskId: 'cleanup',
      attempts: 2,
      recurring: false,
      retry: false,
      data: { roomId: 'r1' },
    });
    expect([...scheduledRuns.values()].some((run) => run.taskId === 'flush' && run.recurring)).toBe(
      true,
    );
    expect(scheduledDlq.get('saved-dlq')).toMatchObject({
      taskId: 'cleanup',
      attempts: 4,
      error: { message: 'boom' },
    });
    expect(getRescheduleCount()).toBe(1);
  });

  it('does not add a second recurring baseline when one already exists', () => {
    const flush = scheduled('flush', async () => {}, { every: 1_000 });
    const { runtime, sql, scheduledRuns } = createRuntime([flush]);

    sql.scheduled.set('existing-recurring', {
      id: 'existing-recurring',
      taskId: 'flush',
      time: 2_000,
      data: null,
      everyMs: 1_000,
      attempts: 0,
      recurring: 1,
      retry: 1,
    });

    bootstrapScheduledRuntime(runtime);

    expect(
      [...scheduledRuns.values()].filter((run) => run.taskId === 'flush' && run.recurring),
    ).toHaveLength(1);
    expect(scheduledRuns.get('existing-recurring')).toMatchObject({
      recurring: true,
      every: 1_000,
    });
  });

  it('queues one-shot runs without affecting the recurring schedule', () => {
    const flush = scheduled('flush', async () => {}, { every: 1_000 });
    const { runtime, sql, scheduledRuns, getRescheduleCount } = createRuntime([flush]);

    scheduleTaskRun(runtime, 'flush', 5_000, { force: true });

    expect([...scheduledRuns.values()]).toEqual([
      expect.objectContaining({
        taskId: 'flush',
        time: 5_000,
        data: { force: true },
        attempts: 0,
        recurring: false,
        retry: true,
      }),
    ]);
    expect(sql.scheduled.size).toBe(1);
    expect(getRescheduleCount()).toBe(1);
  });

  it('copies retry:false from the task definition into one-shot runs', () => {
    const cleanup = scheduled('cleanup', async () => {}, { retry: false });
    const { runtime, scheduledRuns, sql } = createRuntime([cleanup]);

    scheduleTaskRun(runtime, 'cleanup', 5_000, { roomId: 'r1' });

    expect([...scheduledRuns.values()]).toEqual([
      expect.objectContaining({
        taskId: 'cleanup',
        retry: false,
        recurring: false,
      }),
    ]);
    expect([...sql.scheduled.values()]).toEqual([
      expect.objectContaining({
        taskId: 'cleanup',
        retry: 0,
      }),
    ]);
  });

  it('cancels only matching one-shot runs when a filter is provided', () => {
    const flush = scheduled('flush', async () => {}, { every: 1_000 });
    const { runtime, scheduledRuns } = createRuntime([flush]);

    scheduledRuns.set('recurring', {
      id: 'recurring',
      taskId: 'flush',
      time: 10,
      data: undefined,
      every: 1_000,
      attempts: 0,
      recurring: true,
      retry: true,
    });
    scheduledRuns.set('a', {
      id: 'a',
      taskId: 'flush',
      time: 20,
      data: { roomId: 'a' },
      attempts: 0,
      recurring: false,
      retry: true,
    });
    scheduledRuns.set('b', {
      id: 'b',
      taskId: 'flush',
      time: 30,
      data: { roomId: 'b' },
      attempts: 0,
      recurring: false,
      retry: true,
    });

    cancelScheduledRuns(runtime, 'flush', { roomId: 'a' });

    expect([...scheduledRuns.keys()]).toEqual(['recurring', 'b']);
  });

  it('does not cancel runs when the filter does not match or the payload is not an object', () => {
    const flush = scheduled('flush', async () => {});
    const { runtime, scheduledRuns } = createRuntime([flush]);

    scheduledRuns.set('object-run', {
      id: 'object-run',
      taskId: 'flush',
      time: 20,
      data: { roomId: 'a', kind: 'force' },
      attempts: 0,
      recurring: false,
      retry: true,
    });
    scheduledRuns.set('scalar-run', {
      id: 'scalar-run',
      taskId: 'flush',
      time: 30,
      data: 'plain-string',
      attempts: 0,
      recurring: false,
      retry: true,
    });

    cancelScheduledRuns(runtime, 'flush', { roomId: 'b' });
    expect([...scheduledRuns.keys()]).toEqual(['object-run', 'scalar-run']);

    cancelScheduledRuns(runtime, 'flush', { roomId: 'a', kind: 'other' });
    expect([...scheduledRuns.keys()]).toEqual(['object-run', 'scalar-run']);
  });

  it('removes recurring and one-shot runs when no filter is provided', () => {
    const flush = scheduled('flush', async () => {}, { every: 1_000 });
    const { runtime, scheduledRuns } = createRuntime([flush]);

    scheduledRuns.set('recurring', {
      id: 'recurring',
      taskId: 'flush',
      time: 10,
      data: undefined,
      every: 1_000,
      attempts: 0,
      recurring: true,
      retry: true,
    });
    scheduledRuns.set('one-shot', {
      id: 'one-shot',
      taskId: 'flush',
      time: 20,
      data: { roomId: 'a' },
      attempts: 0,
      recurring: false,
      retry: true,
    });

    cancelScheduledRuns(runtime, 'flush');

    expect(scheduledRuns.size).toBe(0);
  });

  it('retries failed runs with 1s, 5s, then 25s backoff before dead-lettering', async () => {
    const flush = scheduled('flush', async () => {
      throw new Error('boom');
    });
    const { runtime, scheduledRuns, scheduledDlq } = createRuntime([flush]);

    scheduledRuns.set('run-1', {
      id: 'run-1',
      taskId: 'flush',
      time: 0,
      data: { force: true },
      attempts: 0,
      recurring: false,
      retry: true,
    });

    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(100);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run-1')).toMatchObject({ time: 1_100, attempts: 1 });

    nowSpy.mockReturnValue(1_100);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run-1')).toMatchObject({ time: 6_100, attempts: 2 });

    nowSpy.mockReturnValue(6_100);
    await handleScheduledAlarm(runtime);
    expect(scheduledRuns.get('run-1')).toMatchObject({ time: 31_100, attempts: 3 });

    nowSpy.mockReturnValue(31_100);
    await handleScheduledAlarm(runtime);
    nowSpy.mockRestore();

    expect(scheduledRuns.has('run-1')).toBe(false);
    expect(scheduledDlq.get('run-1')).toMatchObject({
      attempts: 4,
      error: { message: 'boom', name: 'Error' },
    });
  });

  it('moves failed runs straight to the DLQ when retry is false', async () => {
    const cleanup = scheduled(
      'cleanup',
      async () => {
        throw new Error('no retry');
      },
      { retry: false },
    );
    const { runtime, scheduledRuns, scheduledDlq } = createRuntime([cleanup]);

    scheduledRuns.set('run-1', {
      id: 'run-1',
      taskId: 'cleanup',
      time: 0,
      data: { roomId: 'r1' },
      attempts: 0,
      recurring: false,
      retry: false,
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(500);
    await handleScheduledAlarm(runtime);
    nowSpy.mockRestore();

    expect(scheduledRuns.size).toBe(0);
    expect(scheduledDlq.get('run-1')).toMatchObject({
      failedAt: 500,
      attempts: 1,
      error: { message: 'no retry', name: 'Error' },
    });
  });

  it('keeps recurring runs alive after a terminal failure by scheduling the next interval', async () => {
    const flush = scheduled(
      'flush',
      async () => {
        throw new Error('boom');
      },
      { every: 1_000, retry: false },
    );
    const { runtime, scheduledRuns, scheduledDlq } = createRuntime([flush]);

    scheduledRuns.set('recurring-run', {
      id: 'recurring-run',
      taskId: 'flush',
      time: 0,
      data: undefined,
      every: 1_000,
      attempts: 0,
      recurring: true,
      retry: false,
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    await handleScheduledAlarm(runtime);
    nowSpy.mockRestore();

    expect(scheduledDlq.get('recurring-run')).toBeDefined();
    expect([...scheduledRuns.values()]).toContainEqual(
      expect.objectContaining({
        taskId: 'flush',
        time: 3_000,
        recurring: true,
        attempts: 0,
      }),
    );
  });

  it('runs all due tasks in parallel', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const started: string[] = [];

    const first = scheduled('first', async () => {
      started.push('first');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = scheduled('second', async () => {
      started.push('second');
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    });
    const { runtime, scheduledRuns } = createRuntime([first, second]);

    scheduledRuns.set('first-run', {
      id: 'first-run',
      taskId: 'first',
      time: 0,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: true,
    });
    scheduledRuns.set('second-run', {
      id: 'second-run',
      taskId: 'second',
      time: 0,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: true,
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100);
    const alarmPromise = handleScheduledAlarm(runtime);

    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);

    releaseFirst();
    releaseSecond();
    await alarmPromise;
    nowSpy.mockRestore();

    expect(scheduledRuns.size).toBe(0);
  });

  it('reschedules the next alarm and does nothing else when no runs are due', async () => {
    const flush = scheduled('flush', async () => {});
    const { runtime, scheduledRuns, scheduledDlq, getRescheduleCount } = createRuntime([flush]);

    scheduledRuns.set('future-run', {
      id: 'future-run',
      taskId: 'flush',
      time: 10_000,
      data: undefined,
      attempts: 0,
      recurring: false,
      retry: true,
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100);
    await handleScheduledAlarm(runtime);
    nowSpy.mockRestore();

    expect(scheduledRuns.has('future-run')).toBe(true);
    expect(scheduledDlq.size).toBe(0);
    expect(getRescheduleCount()).toBe(1);
  });
});
