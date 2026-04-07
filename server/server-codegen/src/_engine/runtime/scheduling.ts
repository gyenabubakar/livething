import type { AnyScheduled } from '../compile/types.ts';
import type { ScheduledRun, SchedulingRuntime } from './types.ts';

/**
 * Restore scheduled task runs from adapter storage on engine startup.
 */
export function restoreScheduledRuns(
  runtime: Pick<SchedulingRuntime, 'storage' | 'scheduledRuns'>,
): void {
  if (!runtime.storage) return;

  runtime.storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS _wskit_scheduled (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, time INTEGER NOT NULL, data TEXT, everyMs INTEGER)',
  );

  const rows = runtime.storage.sql
    .exec('SELECT id, taskId, time, data, everyMs FROM _wskit_scheduled')
    .toArray();

  for (const row of rows) {
    runtime.scheduledRuns.set(String(row.id), {
      id: String(row.id),
      taskId: String(row.taskId),
      time: Number(row.time),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      every: row.everyMs == null ? undefined : Number(row.everyMs),
    });
  }
}

/**
 * Persist the full scheduled-run table back to adapter storage.
 */
export function persistScheduledRuns(
  runtime: Pick<SchedulingRuntime, 'storage' | 'scheduledRuns'>,
): void {
  if (!runtime.storage) return;

  const runs = [...runtime.scheduledRuns.values()];
  runtime.storage.sql.transaction((tx) => {
    tx.exec('DELETE FROM _wskit_scheduled');
    for (const run of runs) {
      tx.exec(
        'INSERT INTO _wskit_scheduled (id, taskId, time, data, everyMs) VALUES (?, ?, ?, ?, ?)',
        run.id,
        run.taskId,
        run.time,
        run.data === undefined ? null : JSON.stringify(run.data),
        run.every ?? null,
      );
    }
  });
}

/**
 * Run every scheduled task that is due right now, then plan the next wake-up.
 */
export async function handleAlarm(runtime: SchedulingRuntime): Promise<void> {
  const now = Date.now();
  const due = [...runtime.scheduledRuns.values()].filter((run) => run.time <= now);

  for (const run of due) {
    const task = runtime.compiled.scheduled.get(run.taskId);
    if (task?.handler) {
      await task.handler(runtime.createTaskContext(), run.data);
    }
    runtime.scheduledRuns.delete(run.id);

    if (run.every) {
      runtime.scheduledRuns.set(run.id, {
        ...run,
        time: now + run.every,
      });
    }
  }

  persistScheduledRuns(runtime);
  rescheduleAlarm(runtime);
}

/**
 * Enqueue one future task run.
 */
export function scheduleTask(
  runtime: Pick<SchedulingRuntime, 'compiled' | 'scheduledRuns' | 'generateId'> & {
    persistScheduledRuns(): void;
    rescheduleAlarm(): void;
  },
  taskId: string,
  time: number,
  data: unknown,
): void {
  const task = runtime.compiled.scheduled.get(taskId) as AnyScheduled | undefined;
  const run: ScheduledRun = {
    id: runtime.generateId('task'),
    taskId,
    time,
    data,
    every: task?.options?.every,
  };

  runtime.scheduledRuns.set(run.id, run);
  runtime.persistScheduledRuns();
  runtime.rescheduleAlarm();
}

/**
 * Remove every queued run for the given scheduled task id.
 */
export function cancelScheduled(
  runtime: Pick<SchedulingRuntime, 'scheduledRuns'> & {
    persistScheduledRuns(): void;
    rescheduleAlarm(): void;
  },
  taskId: string,
): void {
  for (const [id, run] of runtime.scheduledRuns) {
    if (run.taskId === taskId) {
      runtime.scheduledRuns.delete(id);
    }
  }

  runtime.persistScheduledRuns();
  runtime.rescheduleAlarm();
}

/**
 * Ask the adapter timer API to wake the engine when the next task becomes due.
 */
export function rescheduleAlarm(runtime: SchedulingRuntime): void {
  if (!runtime.timers) return;

  const nextRun = [...runtime.scheduledRuns.values()].sort((a, b) => a.time - b.time)[0];

  if (!nextRun) {
    if (runtime.alarmState.current !== null) {
      runtime.timers.clearTimeout(runtime.alarmState.current);
      runtime.alarmState.current = null;
    }
    return;
  }

  if (runtime.timers.setAlarm) {
    void runtime.timers.setAlarm(nextRun.time);
    return;
  }

  if (runtime.alarmState.current !== null) {
    runtime.timers.clearTimeout(runtime.alarmState.current);
  }

  runtime.alarmState.current = runtime.timers.setTimeout(
    () => {
      void runtime.onAlarm();
    },
    Math.max(0, nextRun.time - Date.now()),
  );
}
