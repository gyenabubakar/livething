import { validateValue } from '~/_engine/compile/utils.ts';
import type {
  ScheduledCancelResult,
  ScheduledDeadLetter,
  ScheduledRuntimeAccess,
} from './types.ts';

const SCHEDULED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __wskit_scheduled (
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
  CREATE TABLE IF NOT EXISTS __wskit_scheduled_dlq (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    time INTEGER NOT NULL,
    failedAt INTEGER NOT NULL,
    data TEXT,
    attempts INTEGER NOT NULL,
    error TEXT NOT NULL
  )
`;
type ScheduledRunRow = {
  id: string;
  taskId: string;
  time: number;
  data: string | null;
  everyMs: number | null;
  attempts: number | null;
  recurring: number | boolean;
  retry: unknown;
};

type ScheduledDeadLetterRow = {
  id: string;
  taskId: string;
  time: number;
  failedAt: number;
  data: string | null;
  attempts: number;
  error: string | null;
};

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

  if (typeof error === 'string') {
    return { message: error };
  }

  // The dead-letter row is the safety net for a failed run. If the
  // alarm handler aborts here the run is already gone from the queue
  // and disappears with no record — so error serialization must be
  // total. JSON.stringify throws on values it cannot serialize (BigInt,
  // symbols, circular references); fall back to a plain string
  // conversion in those cases.
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
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
    tx.exec('DELETE FROM __wskit_scheduled');
    for (const run of runs) {
      tx.exec(
        `
          INSERT INTO __wskit_scheduled (
            id,
            taskId,
            time,
            data,
            everyMs,
            attempts,
            recurring,
            retry
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
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

    tx.exec('DELETE FROM __wskit_scheduled_dlq');
    for (const entry of deadLetters) {
      tx.exec(
        `
          INSERT INTO __wskit_scheduled_dlq (
            id,
            taskId,
            time,
            failedAt,
            data,
            attempts,
            error
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
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
      // Recurring tasks cannot declare .data(...) — the builder rejects
      // the combination at registration. The seed therefore always has
      // an undefined payload.
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

  // Drop rows whose taskId is no longer registered in the handler. A
  // recurring task that gets removed in a redeploy would otherwise live
  // forever: the row stays on disk, every alarm finds the task missing,
  // skips the body, and the recurring branch re-queues the same row for
  // the next interval. The orphan row never reaches a handler and never
  // shrinks the table.
  const knownTaskIds = new Set<string>();
  for (const task of runtime.getScheduledTasks()) {
    knownTaskIds.add(task.taskId);
  }

  for (const row of storage.sql
    .exec<ScheduledRunRow>(
      `
        SELECT id, taskId, time, data, everyMs, attempts, recurring, retry
        FROM __wskit_scheduled
      `,
    )
    .toArray()) {
    const taskId = String(row.taskId);
    if (!knownTaskIds.has(taskId)) continue;
    scheduledRuns.set(String(row.id), {
      id: String(row.id),
      taskId,
      time: Number(row.time),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      every: row.everyMs == null ? undefined : Number(row.everyMs),
      attempts: row.attempts == null ? 0 : Number(row.attempts),
      recurring: row.recurring === 1 || row.recurring === true,
      retry: deserializeRetry(row.retry),
    });
  }

  for (const row of storage.sql
    .exec<ScheduledDeadLetterRow>(
      `
        SELECT id, taskId, time, failedAt, data, attempts, error
        FROM __wskit_scheduled_dlq
      `,
    )
    .toArray()) {
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
        const ctx = runtime.createTaskContext();
        if (task.hasData) {
          await (task.handler as (ctx: unknown, data: unknown) => void | Promise<void>)(
            ctx,
            run.data,
          );
        } else {
          await (task.handler as (ctx: unknown) => void | Promise<void>)(ctx);
        }
      }
      return run;
    }),
  );

  const deadLetters = runtime.getScheduledDlq();

  for (const [index, result] of results.entries()) {
    const run = due[index];
    if (!run) continue;

    if (result.status === 'fulfilled') {
      // Drop the recurring re-queue when the task was removed from the
      // handler between deploys. Without this guard the row keeps coming
      // back on every alarm tick and storage never shrinks.
      if (run.recurring && run.every && runtime.getScheduledTask(run.taskId)) {
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
      // Same orphan guard as the success branch: only re-queue when the
      // task is still registered. A removed task should not leave a
      // recurring run alive even after one of its attempts dead-letters.
      const task = runtime.getScheduledTask(run.taskId);
      if (!task) continue;
      // Recurring tasks cannot declare .data(...) — the builder rejects
      // the combination at registration. The re-queue always has an
      // undefined payload.
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
  if (!task) {
    throw new Error(`[wskit] scheduled task "${taskId}" is not registered.`);
  }
  if (!Number.isInteger(time) || time <= 0) {
    throw new Error(
      `[wskit] ctx.schedule("${taskId}", ...) requires a positive finite integer ` +
        `wall-clock millisecond timestamp for "time". Got ${String(time)}.`,
    );
  }
  const id = runtime.generateId('task');
  let normalizedData = data;

  if (task.hasData) {
    normalizedData = validateValue(task.dataSchema, data, taskId);
  } else if (data !== undefined) {
    throw new Error(`[wskit] scheduled task "${taskId}" does not declare .data(...).`);
  }

  runtime.getScheduledRuns().set(id, {
    id,
    taskId,
    time,
    data: normalizedData,
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
): ScheduledCancelResult {
  const scheduledRuns = runtime.getScheduledRuns();
  const taskExists = !!runtime.getScheduledTask(taskId);
  let removed = 0;

  for (const [id, run] of scheduledRuns) {
    if (run.taskId !== taskId) continue;

    if (run.recurring) {
      if (!filter) {
        scheduledRuns.delete(id);
        removed += 1;
      }
      continue;
    }

    if (dataMatchesFilter(run.data, filter)) {
      scheduledRuns.delete(id);
      removed += 1;
    }
  }

  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
  return { taskExists, removed };
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
    // Native durable alarms (e.g. Cloudflare DOs) survive past the queue
    // emptying. Cancel them too so the platform doesn't wake the DO at an
    // old alarm time to find nothing to run. Adapters without durable
    // alarms omit deleteAlarm and the call no-ops.
    if (timers.deleteAlarm) {
      void timers.deleteAlarm();
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
