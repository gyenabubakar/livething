import type { AnyScheduled } from '~/_engine/compile/types.ts';
import type { StorageProvider, TimerProvider } from '~/context.ts';

/**
 * One queued scheduled task run.
 *
 * This is the runtime record the scheduler keeps in memory and also persists
 * into adapter storage so the queue can survive restarts or hibernation.
 */
export interface ScheduledRun {
  id: string;
  taskId: string;
  time: number;
  data: unknown;
  every?: number;
}

/**
 * The small runtime surface the scheduled primitive needs from the engine.
 *
 * The engine still owns shared state like the in-memory run table and timer
 * handle. The scheduled primitive uses this access object to read that state
 * and perform its own scheduling logic.
 */
export interface ScheduledRuntimeAccess {
  /** Read persistent storage. Throws if storage was not provided by the adapter. */
  requireStorage(): StorageProvider;

  /** Read timers/alarm APIs. Throws if timers were not provided by the adapter. */
  requireTimers(): TimerProvider;

  /** Create a framework-generated id, usually for one queued task run. */
  generateId(prefix?: string): string;

  /** Read the engine-owned in-memory table of queued runs. */
  getScheduledRuns(): Map<string, ScheduledRun>;

  /** Read one declared scheduled task by its task id. */
  getScheduledTask(taskId: string): AnyScheduled | undefined;

  /** Build the context object passed to a scheduled task handler. */
  createTaskContext(): unknown;

  /** Ask the engine to recompute when the next alarm should fire. */
  rescheduleAlarm(): void;
}

const SCHEDULED_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS _wskit_scheduled (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, time INTEGER NOT NULL, data TEXT, everyMs INTEGER)';
const SELECT_SCHEDULED_SQL = 'SELECT id, taskId, time, data, everyMs FROM _wskit_scheduled';
const DELETE_SCHEDULED_SQL = 'DELETE FROM _wskit_scheduled';
const INSERT_SCHEDULED_SQL =
  'INSERT INTO _wskit_scheduled (id, taskId, time, data, everyMs) VALUES (?, ?, ?, ?, ?)';

/**
 * Prepare scheduler storage and restore queued runs into memory.
 *
 * This runs during engine boot, before normal init hooks. It makes sure the
 * scheduler table exists, reads every saved run, and then asks the engine to
 * plan the next alarm.
 */
export function bootstrapScheduledRuntime(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.requireStorage();
  const scheduledRuns = runtime.getScheduledRuns();

  storage.sql.exec(SCHEDULED_TABLE_SQL);

  const rows = storage.sql.exec(SELECT_SCHEDULED_SQL).toArray();
  scheduledRuns.clear();

  for (const row of rows) {
    scheduledRuns.set(String(row.id), {
      id: String(row.id),
      taskId: String(row.taskId),
      time: Number(row.time),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      every: row.everyMs == null ? undefined : Number(row.everyMs),
    });
  }

  runtime.rescheduleAlarm();
}

/**
 * Save the full in-memory scheduled queue back to storage.
 *
 * The current implementation rewrites the table each time so the database
 * stays in sync with the in-memory queue.
 */
export function persistScheduledRuns(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.requireStorage();
  const runs = [...runtime.getScheduledRuns().values()];

  storage.sql.transaction((tx) => {
    tx.exec(DELETE_SCHEDULED_SQL);
    for (const run of runs) {
      tx.exec(
        INSERT_SCHEDULED_SQL,
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
 * Execute every scheduled run that is due right now.
 *
 * After each run, recurring tasks are queued again using their `every` value.
 * When the due work is finished, the queue is persisted and the next alarm is
 * recalculated.
 */
export async function handleScheduledAlarm(runtime: ScheduledRuntimeAccess): Promise<void> {
  const now = Date.now();
  const scheduledRuns = runtime.getScheduledRuns();
  const due = [...scheduledRuns.values()].filter((run) => run.time <= now);

  for (const run of due) {
    const task = runtime.getScheduledTask(run.taskId);
    if (task?.handler) {
      await task.handler(runtime.createTaskContext(), run.data);
    }

    scheduledRuns.delete(run.id);

    if (run.every) {
      scheduledRuns.set(run.id, {
        ...run,
        time: now + run.every,
      });
    }
  }

  persistScheduledRuns(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Queue one future run of a scheduled task.
 *
 * The run is added to the in-memory queue, persisted, and then the next alarm
 * is recalculated.
 */
export function scheduleTaskRun(
  runtime: ScheduledRuntimeAccess,
  taskId: string,
  time: number,
  data: unknown,
): void {
  const task = runtime.getScheduledTask(taskId);
  const run: ScheduledRun = {
    id: runtime.generateId('task'),
    taskId,
    time,
    data,
    every: task?.options?.every,
  };

  runtime.getScheduledRuns().set(run.id, run);
  persistScheduledRuns(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Remove every queued run for one scheduled task id.
 *
 * This is a broad cancel. It removes all queued runs for the task, then saves
 * the updated queue and recalculates the next alarm.
 */
export function cancelScheduledRuns(runtime: ScheduledRuntimeAccess, taskId: string): void {
  const scheduledRuns = runtime.getScheduledRuns();

  for (const [id, run] of scheduledRuns) {
    if (run.taskId === taskId) {
      scheduledRuns.delete(id);
    }
  }

  persistScheduledRuns(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Ask the adapter timer API to wake the engine when the next queued task is due.
 *
 * If the adapter supports a native alarm API, that is used. Otherwise this
 * falls back to an in-memory timeout.
 */
export function rescheduleScheduledAlarm(
  runtime: Pick<ScheduledRuntimeAccess, 'getScheduledRuns' | 'requireTimers'> & {
    getAlarmHandle(): unknown | null;
    setAlarmHandle(handle: unknown | null): void;
    onAlarm(): Promise<void>;
  },
): void {
  const timers = runtime.requireTimers();
  const nextRun = [...runtime.getScheduledRuns().values()].sort((a, b) => a.time - b.time)[0];

  if (!nextRun) {
    if (runtime.getAlarmHandle() !== null) {
      timers.clearTimeout(runtime.getAlarmHandle());
      runtime.setAlarmHandle(null);
    }
    return;
  }

  if (timers.setAlarm) {
    void timers.setAlarm(nextRun.time);
    return;
  }

  if (runtime.getAlarmHandle() !== null) {
    timers.clearTimeout(runtime.getAlarmHandle());
  }

  runtime.setAlarmHandle(
    timers.setTimeout(
      () => {
        void runtime.onAlarm();
      },
      Math.max(0, nextRun.time - Date.now()),
    ),
  );
}
