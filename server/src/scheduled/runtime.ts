import type { ScheduledDeadLetter, ScheduledRuntimeAccess } from './types.ts';

const SCHEDULED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_scheduled (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    time INTEGER NOT NULL,
    data TEXT,
    everyMs INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    recurring INTEGER NOT NULL DEFAULT 0,
    retry INTEGER NOT NULL DEFAULT 1
  )
`;

const SCHEDULED_DLQ_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _wskit_scheduled_dlq (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    time INTEGER NOT NULL,
    failedAt INTEGER NOT NULL,
    data TEXT,
    attempts INTEGER NOT NULL,
    error TEXT NOT NULL
  )
`;
const SELECT_SCHEDULED_SQL = `
  SELECT id, taskId, time, data, everyMs, attempts, recurring, retry
  FROM _wskit_scheduled
`;
const SELECT_SCHEDULED_DLQ_SQL = `
  SELECT id, taskId, time, failedAt, data, attempts, error
  FROM _wskit_scheduled_dlq
`;

const DELETE_SCHEDULED_SQL = 'DELETE FROM _wskit_scheduled';
const DELETE_SCHEDULED_DLQ_SQL = 'DELETE FROM _wskit_scheduled_dlq';

const INSERT_SCHEDULED_SQL = `
  INSERT INTO _wskit_scheduled (
    id,
    taskId,
    time,
    data,
    everyMs,
    attempts,
    recurring,
    retry
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_SCHEDULED_DLQ_SQL = `
  INSERT INTO _wskit_scheduled_dlq (
    id,
    taskId,
    time,
    failedAt,
    data,
    attempts,
    error
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 5_000, 25_000];

function deserializeRetry(value: unknown): boolean | readonly number[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as number[];
    } catch {
      // fall through
    }
  }
  if (value === 0 || value === false) return false;
  return true;
}

function serializeError(error: unknown): ScheduledDeadLetter['error'] {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
}

function dataMatchesFilter(data: unknown, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  if (!data || typeof data !== 'object') return false;

  const object = data as Record<string, unknown>;
  for (const [key, expected] of Object.entries(filter)) {
    if (object[key] !== expected) return false;
  }

  return true;
}

function getRetryDelay(attempts: number, retry: boolean | readonly number[]): number | undefined {
  if (retry === false) return undefined;
  const schedule = Array.isArray(retry) ? retry : DEFAULT_BACKOFF_MS;
  return schedule[attempts];
}

/**
 * Serialize the in-memory run queue and dead-letter queue back to SQLite.
 *
 * This replaces the entire table contents in a single transaction so the
 * persisted state always matches what the engine holds in memory.
 */
function persistSchedulerState(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.requireStorage();
  const runs = [...runtime.getScheduledRuns().values()];
  const deadLetters = [...runtime.getScheduledDlq().values()];

  storage.sql.exec(SCHEDULED_TABLE_SQL);
  storage.sql.exec(SCHEDULED_DLQ_TABLE_SQL);
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
        run.attempts,
        run.recurring ? 1 : 0,
        Array.isArray(run.retry) ? JSON.stringify(run.retry) : run.retry ? 1 : 0,
      );
    }

    tx.exec(DELETE_SCHEDULED_DLQ_SQL);
    for (const entry of deadLetters) {
      tx.exec(
        INSERT_SCHEDULED_DLQ_SQL,
        entry.id,
        entry.taskId,
        entry.time,
        entry.failedAt,
        entry.data === undefined ? null : JSON.stringify(entry.data),
        entry.attempts,
        JSON.stringify(entry.error),
      );
    }
  });
}

/**
 * Seed a recurring run for each `.scheduled()` task that declares an `every`
 * interval but does not already have one queued.
 *
 * Called at boot so that recurring tasks resume even after a restart or
 * hibernation wake.
 */
function ensureRecurringRuns(runtime: ScheduledRuntimeAccess): void {
  const scheduledRuns = runtime.getScheduledRuns();
  const now = Date.now();

  for (const task of runtime.getScheduledTasks()) {
    const every = task.options?.every;
    if (!every) continue;

    const hasRecurringRun = [...scheduledRuns.values()].some(
      (run) => run.taskId === task.taskId && run.recurring,
    );

    if (!hasRecurringRun) {
      const id = runtime.generateId('task');
      scheduledRuns.set(id, {
        id,
        taskId: task.taskId,
        time: now + every,
        data: undefined,
        every,
        attempts: 0,
        recurring: true,
        retry: task.options?.retry ?? true,
      });
    }
  }
}

/**
 * Prepare scheduler storage and restore queued runs into memory.
 *
 * This runs during engine boot, before normal init hooks. It makes sure the
 * scheduler tables exist, restores queued and dead-lettered runs, rebuilds the
 * recurring baseline queue, and then asks the engine to plan the next alarm.
 */
export function bootstrapScheduledRuntime(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.requireStorage();
  const scheduledRuns = runtime.getScheduledRuns();
  const deadLetters = runtime.getScheduledDlq();

  storage.sql.exec(SCHEDULED_TABLE_SQL);
  storage.sql.exec(SCHEDULED_DLQ_TABLE_SQL);

  scheduledRuns.clear();
  deadLetters.clear();

  for (const row of storage.sql.exec(SELECT_SCHEDULED_SQL).toArray()) {
    scheduledRuns.set(String(row.id), {
      id: String(row.id),
      taskId: String(row.taskId),
      time: Number(row.time),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      every: row.everyMs == null ? undefined : Number(row.everyMs),
      attempts: row.attempts == null ? 0 : Number(row.attempts),
      recurring: row.recurring === 1 || row.recurring === true,
      retry: deserializeRetry(row.retry),
    });
  }

  for (const row of storage.sql.exec(SELECT_SCHEDULED_DLQ_SQL).toArray()) {
    deadLetters.set(String(row.id), {
      id: String(row.id),
      taskId: String(row.taskId),
      time: Number(row.time),
      failedAt: Number(row.failedAt),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      attempts: Number(row.attempts),
      error:
        typeof row.error === 'string' && row.error.length > 0
          ? (JSON.parse(row.error) as ScheduledDeadLetter['error'])
          : { message: 'Unknown scheduled task failure' },
    });
  }

  ensureRecurringRuns(runtime);
  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Execute every scheduled run that is due right now.
 *
 * Due runs are first claimed from the live queue, then executed in parallel.
 * Failed runs are retried with backoff or moved into the internal dead-letter
 * queue, depending on the task's retry policy.
 */
export async function handleScheduledAlarm(runtime: ScheduledRuntimeAccess): Promise<void> {
  const now = Date.now();
  const scheduledRuns = runtime.getScheduledRuns();
  const due = [...scheduledRuns.values()].filter((run) => run.time <= now);

  if (due.length === 0) {
    runtime.rescheduleAlarm();
    return;
  }

  for (const run of due) {
    scheduledRuns.delete(run.id);
  }

  persistSchedulerState(runtime);

  const results = await Promise.allSettled(
    due.map(async (run) => {
      const task = runtime.getScheduledTask(run.taskId);
      if (task?.handler) {
        await task.handler(runtime.createTaskContext(), run.data);
      }
      return run;
    }),
  );

  const deadLetters = runtime.getScheduledDlq();

  for (const [index, result] of results.entries()) {
    const run = due[index];
    if (!run) continue;

    if (result.status === 'fulfilled') {
      if (run.recurring && run.every) {
        scheduledRuns.set(run.id, {
          ...run,
          time: now + run.every,
          attempts: 0,
        });
      }
      continue;
    }

    const nextAttempts = run.attempts + 1;
    const retryDelay = run.retry ? getRetryDelay(run.attempts, run.retry) : undefined;

    if (retryDelay !== undefined) {
      scheduledRuns.set(run.id, {
        ...run,
        time: now + retryDelay,
        attempts: nextAttempts,
      });
      continue;
    }

    deadLetters.set(run.id, {
      id: run.id,
      taskId: run.taskId,
      time: run.time,
      failedAt: now,
      data: run.data,
      attempts: nextAttempts,
      error: serializeError(result.reason),
    });

    if (run.recurring && run.every) {
      const id = runtime.generateId('task');
      scheduledRuns.set(id, {
        id,
        taskId: run.taskId,
        time: now + run.every,
        data: undefined,
        every: run.every,
        attempts: 0,
        recurring: true,
        retry: run.retry,
      });
    }
  }

  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Queue one future run of a scheduled task.
 *
 * This always creates a one-shot run, even if the task also has a recurring
 * `every` schedule.
 */
export function scheduleTaskRun(
  runtime: ScheduledRuntimeAccess,
  taskId: string,
  time: number,
  data: unknown,
): void {
  const task = runtime.getScheduledTask(taskId);
  const id = runtime.generateId('task');

  runtime.getScheduledRuns().set(id, {
    id,
    taskId,
    time,
    data,
    attempts: 0,
    recurring: false,
    retry: task?.options?.retry ?? true,
  });

  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Remove queued runs for one task id.
 *
 * With no filter, all one-shot runs are removed and recurring runs are stopped.
 * With a filter, only runs whose data matches the provided keys are removed.
 */
export function cancelScheduledRuns(
  runtime: ScheduledRuntimeAccess,
  taskId: string,
  filter?: Record<string, unknown>,
): void {
  const scheduledRuns = runtime.getScheduledRuns();

  for (const [id, run] of scheduledRuns) {
    if (run.taskId !== taskId) continue;

    if (run.recurring) {
      if (!filter) {
        scheduledRuns.delete(id);
      }
      continue;
    }

    if (dataMatchesFilter(run.data, filter)) {
      scheduledRuns.delete(id);
    }
  }

  persistSchedulerState(runtime);
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
