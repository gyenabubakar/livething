import { validateValue } from '~/_engine/compile/utils.ts';
import { serializeJsonOrThrow } from '~/_engine/runtime/json-guard.ts';
import { assertPositiveInteger } from '~/_engine/validation.ts';
import type {
  ScheduledCancelResult,
  ScheduledDeadLetter,
  ScheduledRun,
  ScheduledRuntimeAccess,
} from './types.ts';

const SCHEDULED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_scheduled (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    time INTEGER NOT NULL,
    data TEXT,
    everyMs INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    recurring INTEGER NOT NULL DEFAULT 0,
    retry INTEGER NOT NULL DEFAULT 1,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

const SCHEDULED_DLQ_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_scheduled_dlq (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    time INTEGER NOT NULL,
    failedAt INTEGER NOT NULL,
    data TEXT,
    attempts INTEGER NOT NULL,
    error TEXT NOT NULL,
    -- Reserved JSON blob: lets us add per-row fields later without a migration.
    metadata TEXT NOT NULL DEFAULT '{}'
  )
`;

// One row per recurring (`every`) task that `ctx.cancelScheduled(taskId)` stopped.
// Boot does not re-seed a stopped task; `ctx.schedule(taskId, ...)` starts it again.
const SCHEDULED_STOPPED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __livething_scheduled_stopped (
    taskId TEXT PRIMARY KEY,
    stoppedAt INTEGER NOT NULL
  )
`;

// All DDL statements bundled — one round trip.
const SCHEDULED_SCHEMA_SQL = [
  SCHEDULED_TABLE_SQL,
  SCHEDULED_DLQ_TABLE_SQL,
  SCHEDULED_STOPPED_TABLE_SQL,
].join(';\n');
type ScheduledRunRow = {
  id: string;
  taskId: string;
  time: number;
  data: string | null;
  everyMs: number | null;
  attempts: number | null;
  recurring: number | boolean;
  retry: unknown;
  /** Forward-compat blob (see the metadata column); not yet read or written. */
  metadata?: Record<string, unknown>;
};

type ScheduledDeadLetterRow = {
  id: string;
  taskId: string;
  time: number;
  failedAt: number;
  data: string | null;
  attempts: number;
  error: string | null;
  /** Forward-compat blob (see the metadata column); not yet read or written. */
  metadata?: Record<string, unknown>;
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

function serializeRetry(retry: ScheduledRun['retry']): number | string {
  if (Array.isArray(retry)) return JSON.stringify(retry);

  return retry ? 1 : 0;
}

/** Serialize one run row into its persisted column tuple for hashing/binding. */
function serializeRunColumns(
  run: ScheduledRun,
): [string, string, number, string | null, number | null, number, number, number | string] {
  return [
    run.id,
    run.taskId,
    run.time,
    run.data === undefined
      ? null
      : serializeJsonOrThrow(run.data, `Scheduled task data for "${run.taskId}"`),
    run.every ?? null,
    run.attempts,
    run.recurring ? 1 : 0,
    serializeRetry(run.retry),
  ];
}

/** Serialize one DLQ row into its persisted column tuple. */
function serializeDlqColumns(
  entry: ScheduledDeadLetter,
): [string, string, number, number, string | null, number, string] {
  return [
    entry.id,
    entry.taskId,
    entry.time,
    entry.failedAt,
    entry.data === undefined
      ? null
      : serializeJsonOrThrow(entry.data, `Scheduled DLQ data for "${entry.taskId}"`),
    entry.attempts,
    JSON.stringify(entry.error),
  ];
}

/** Stable string fingerprint for the persisted form of one row. */
function fingerprint(columns: readonly unknown[]): string {
  return JSON.stringify(columns);
}

/** One pending change to the scheduler tables, computed against the snapshot. */
interface DiffOp {
  kind: 'insert' | 'update' | 'delete';
  id: string;
  fingerprint?: string;
  columns?: readonly unknown[];
}

/**
 * Diff the current map against the persisted snapshot. Returns the list of
 * inserts (new id), updates (id seen, fingerprint changed), and deletes (id
 * gone from current). The caller emits SQL for each op and updates the
 * snapshot to match.
 */
function diffAgainstSnapshot<T>(
  current: ReadonlyMap<string, T>,
  snapshot: ReadonlyMap<string, string>,
  serialize: (value: T) => readonly unknown[],
): DiffOp[] {
  const ops: DiffOp[] = [];

  for (const [id, value] of current) {
    const columns = serialize(value);
    const fp = fingerprint(columns);
    const previous = snapshot.get(id);
    if (previous === undefined) {
      ops.push({ kind: 'insert', id, fingerprint: fp, columns });
    } else if (previous !== fp) {
      ops.push({ kind: 'update', id, fingerprint: fp, columns });
    }
  }

  for (const id of snapshot.keys()) {
    if (!current.has(id)) {
      ops.push({ kind: 'delete', id });
    }
  }

  return ops;
}

/**
 * Run ids currently claimed off the queue by an in-progress alarm fire, per
 * durable object. While a run's id is in this set, a persist must not delete
 * its durable row even though the id is (temporarily) absent from the live
 * `scheduledRuns` map — see `persistSchedulerState`.
 *
 * Keyed on the live `scheduledRuns` map rather than the `ScheduledRuntimeAccess`
 * wrapper: `buildAccess` constructs a fresh wrapper object on every call (the
 * alarm hook, `scheduleTask`, `cancelScheduled` each build their own), but
 * `getScheduledRuns()` always returns the same `Map` instance for a given
 * durable object, so it is the stable identity to key on.
 */
const claimedRunIds = new WeakMap<Map<string, ScheduledRun>, Set<string>>();

function getClaimedRunIds(runtime: ScheduledRuntimeAccess): Set<string> {
  const scheduledRuns = runtime.getScheduledRuns();
  let claimed = claimedRunIds.get(scheduledRuns);
  if (!claimed) {
    claimed = new Set();
    claimedRunIds.set(scheduledRuns, claimed);
  }

  return claimed;
}

/**
 * Persist scheduler state by writing only the rows that actually changed
 * since the previous persist. The snapshot maps mirror the durable table
 * contents — they are updated in lock-step with successful SQL writes so the
 * next diff sees an accurate baseline.
 *
 * On a steady-state recurring task tick this collapses to a single `UPDATE`
 * (the run id stays the same; only `time` and `attempts` change), instead of
 * the previous `DELETE *` + reinsert-all pattern that wrote one row per
 * queued task on every fire.
 *
 * Delivery is at-least-once: `handleScheduledAlarm` claims due runs off the
 * live map before invoking their handlers, so a crash mid-handler still finds
 * the run in storage and re-fires it on restart. A handler that calls
 * `ctx.schedule`/`ctx.cancelScheduled` triggers this same function again
 * before the alarm's own run finishes — that write must not also delete the
 * still-claimed run's durable row, or a crash right after it would lose the
 * run for good. Deletes for a claimed id are skipped here; the alarm clears
 * the claim once its handler settles, so its own closing persist deletes the
 * row normally.
 */
function persistSchedulerState(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.getStorage();
  const runs = runtime.getScheduledRuns();
  const deadLetters = runtime.getScheduledDlq();
  const runsSnapshot = runtime.getScheduledRunsPersisted();
  const dlqSnapshot = runtime.getScheduledDlqPersisted();

  const claimed = getClaimedRunIds(runtime);

  const runOps = diffAgainstSnapshot(runs, runsSnapshot, serializeRunColumns).filter(
    (op) => op.kind !== 'delete' || !claimed.has(op.id),
  );
  const dlqOps = diffAgainstSnapshot(deadLetters, dlqSnapshot, serializeDlqColumns);

  if (runOps.length === 0 && dlqOps.length === 0) {
    return;
  }

  runtime.logger.info('[livething] scheduler persist — applying diff', {
    runs: summarizeOps(runOps),
    deadLetters: summarizeOps(dlqOps),
  });

  storage.sql.transaction(() => {
    for (const op of runOps) {
      if (op.kind === 'delete') {
        storage.sql.exec('DELETE FROM __livething_scheduled WHERE id = ?', op.id);
        continue;
      }

      if (op.kind === 'insert') {
        storage.sql.exec(
          `INSERT INTO __livething_scheduled
            (id, taskId, time, data, everyMs, attempts, recurring, retry)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ...(op.columns as unknown[]),
        );
        continue;
      }

      // update — id is at position 0 of the columns tuple; rebind it as the
      // WHERE clause and skip it in the SET list so the row stays addressable.
      const [, taskId, time, data, everyMs, attempts, recurring, retry] = op.columns as [
        string,
        string,
        number,
        string | null,
        number | null,
        number,
        number,
        number | string,
      ];
      storage.sql.exec(
        `UPDATE __livething_scheduled
         SET taskId = ?, time = ?, data = ?, everyMs = ?, attempts = ?, recurring = ?, retry = ?
         WHERE id = ?`,
        taskId,
        time,
        data,
        everyMs,
        attempts,
        recurring,
        retry,
        op.id,
      );
    }

    for (const op of dlqOps) {
      if (op.kind === 'delete') {
        storage.sql.exec('DELETE FROM __livething_scheduled_dlq WHERE id = ?', op.id);
        continue;
      }

      if (op.kind === 'insert') {
        storage.sql.exec(
          `INSERT INTO __livething_scheduled_dlq
            (id, taskId, time, failedAt, data, attempts, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ...(op.columns as unknown[]),
        );
        continue;
      }

      const [, taskId, time, failedAt, data, attempts, error] = op.columns as [
        string,
        string,
        number,
        number,
        string | null,
        number,
        string,
      ];
      storage.sql.exec(
        `UPDATE __livething_scheduled_dlq
         SET taskId = ?, time = ?, failedAt = ?, data = ?, attempts = ?, error = ?
         WHERE id = ?`,
        taskId,
        time,
        failedAt,
        data,
        attempts,
        error,
        op.id,
      );
    }
  });

  applyDiffToSnapshot(runOps, runsSnapshot);
  applyDiffToSnapshot(dlqOps, dlqSnapshot);
}

/** Update the in-memory snapshot to reflect a successfully-applied diff. */
function applyDiffToSnapshot(ops: readonly DiffOp[], snapshot: Map<string, string>): void {
  for (const op of ops) {
    if (op.kind === 'delete') {
      snapshot.delete(op.id);
    } else if (op.fingerprint !== undefined) {
      snapshot.set(op.id, op.fingerprint);
    }
  }
}

/** Compact `{ inserts, updates, deletes }` shape for the persist log line. */
function summarizeOps(ops: readonly DiffOp[]): {
  inserts: number;
  updates: number;
  deletes: number;
} {
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  for (const op of ops) {
    if (op.kind === 'insert') inserts += 1;
    else if (op.kind === 'update') updates += 1;
    else deletes += 1;
  }

  return { inserts, updates, deletes };
}

/** Task ids of recurring tasks stopped by `ctx.cancelScheduled(taskId)`. */
function readStoppedTaskIds(runtime: ScheduledRuntimeAccess): Set<string> {
  const rows = runtime
    .getStorage()
    .sql.exec<{ taskId: string }>('SELECT taskId FROM __livething_scheduled_stopped')
    .toArray();
  return new Set(rows.map((row) => String(row.taskId)));
}

/** Record that a recurring task was stopped. Returns `false` when it already was. */
function markTaskStopped(runtime: ScheduledRuntimeAccess, taskId: string): boolean {
  const sql = runtime.getStorage().sql;
  const existing = sql
    .exec('SELECT 1 FROM __livething_scheduled_stopped WHERE taskId = ?', taskId)
    .toArray();
  if (existing.length > 0) return false;

  sql.exec(
    'INSERT INTO __livething_scheduled_stopped (taskId, stoppedAt) VALUES (?, ?)',
    taskId,
    Date.now(),
  );

  return true;
}

/** Clear a stopped marker. Returns `true` when the task was stopped. */
function clearTaskStopped(runtime: ScheduledRuntimeAccess, taskId: string): boolean {
  const sql = runtime.getStorage().sql;
  const existing = sql
    .exec('SELECT 1 FROM __livething_scheduled_stopped WHERE taskId = ?', taskId)
    .toArray();
  if (existing.length === 0) return false;

  sql.exec('DELETE FROM __livething_scheduled_stopped WHERE taskId = ?', taskId);

  return true;
}

/**
 * Seed a recurring run for each `.scheduled()` task that declares an `every`
 * interval but does not already have one queued. A task stopped by
 * `ctx.cancelScheduled(taskId)` is not seeded.
 *
 * Called at boot so that recurring tasks continue even after a restart or
 * hibernation wake.
 */
function ensureRecurringRuns(runtime: ScheduledRuntimeAccess, stopped: ReadonlySet<string>): void {
  const scheduledRuns = runtime.getScheduledRuns();
  const now = Date.now();

  for (const task of runtime.getScheduledTasks()) {
    const every = task.options?.every;
    if (!every || stopped.has(task.taskId)) continue;

    const hasRecurringRun = [...scheduledRuns.values()].some(
      (run) => run.taskId === task.taskId && run.recurring,
    );

    if (!hasRecurringRun) {
      // A task with `every` cannot declare `data` — `scheduled({...})` rejects
      // the combination. The seed therefore always has an undefined payload.
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
 * Create the scheduler tables. Idempotent. The engine routes this through
 * `onBootSchema` so the tables are ensured on every boot.
 */
export function ensureScheduledSchema(runtime: ScheduledRuntimeAccess): void {
  runtime.getStorage().sql.exec(SCHEDULED_SCHEMA_SQL);
}

/**
 * Restore queued runs and dead-lettered runs into memory. Always runs on
 * every boot. Assumes the schema already exists (either freshly created in
 * `ensureScheduledSchema` on cold boot, or from a previous boot on wake).
 */
export function bootstrapScheduledRuntime(runtime: ScheduledRuntimeAccess): void {
  const storage = runtime.getStorage();
  const scheduledRuns = runtime.getScheduledRuns();
  const deadLetters = runtime.getScheduledDlq();
  const runsSnapshot = runtime.getScheduledRunsPersisted();
  const dlqSnapshot = runtime.getScheduledDlqPersisted();

  scheduledRuns.clear();
  deadLetters.clear();
  runsSnapshot.clear();
  dlqSnapshot.clear();

  runtime.logger.info('[livething] scheduler boot — loading queue from storage');

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
        FROM __livething_scheduled
      `,
    )
    .toArray()) {
    const taskId = String(row.taskId);
    if (!knownTaskIds.has(taskId)) {
      // Orphan row — the taskId is no longer registered, so the run is dropped
      // from the in-memory queue. Seed the snapshot with a sentinel so the
      // first post-boot persist diffs it as "in storage but not in current"
      // and emits the targeted DELETE. Without this, the orphan row leaks.
      runsSnapshot.set(String(row.id), 'orphan');
      continue;
    }

    const run: ScheduledRun = {
      id: String(row.id),
      taskId,
      time: Number(row.time),
      data: typeof row.data === 'string' && row.data.length > 0 ? JSON.parse(row.data) : undefined,
      every: row.everyMs == null ? undefined : Number(row.everyMs),
      attempts: row.attempts == null ? 0 : Number(row.attempts),
      recurring: row.recurring === 1 || row.recurring === true,
      retry: deserializeRetry(row.retry),
    };

    scheduledRuns.set(run.id, run);
    // Seed the snapshot with what we just read so the next persist diff
    // treats these rows as already-on-disk and skips re-writing them.
    runsSnapshot.set(run.id, fingerprint(serializeRunColumns(run)));
  }

  for (const row of storage.sql
    .exec<ScheduledDeadLetterRow>(
      `
        SELECT id, taskId, time, failedAt, data, attempts, error
        FROM __livething_scheduled_dlq
      `,
    )
    .toArray()) {
    const entry: ScheduledDeadLetter = {
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
    };

    deadLetters.set(entry.id, entry);
    dlqSnapshot.set(entry.id, fingerprint(serializeDlqColumns(entry)));
  }

  // A stopped marker only matters for a task that still declares `every`.
  const recurringTaskIds = new Set<string>();
  for (const task of runtime.getScheduledTasks()) {
    if (task.options?.every) recurringTaskIds.add(task.taskId);
  }

  const stopped = readStoppedTaskIds(runtime);
  for (const taskId of stopped) {
    if (recurringTaskIds.has(taskId)) continue;

    storage.sql.exec('DELETE FROM __livething_scheduled_stopped WHERE taskId = ?', taskId);
    stopped.delete(taskId);
  }

  // Stopping writes the marker and deletes the queued run in two writes. A
  // process that died between them leaves both, so drop the run here.
  for (const [id, run] of scheduledRuns) {
    if (run.recurring && stopped.has(run.taskId)) scheduledRuns.delete(id);
  }

  ensureRecurringRuns(runtime, stopped);
  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();

  runtime.logger.info('[livething] scheduler boot complete', {
    queuedRuns: scheduledRuns.size,
    deadLetters: deadLetters.size,
    recurringTaskIds: [...scheduledRuns.values()]
      .filter((run) => run.recurring)
      .map((run) => run.taskId),
  });
}

/**
 * Execute every scheduled run that is due right now.
 *
 * Due runs are first claimed from the live queue, then executed in parallel.
 * Failed runs are retried with backoff or moved into the internal dead-letter
 * queue, depending on the task's retry policy.
 */
interface RunnableTask {
  handler: (ctx: unknown, data?: unknown) => void | Promise<void>;
  hasData: boolean;
}

/** Call a task's handler, with its data only when the task declares data. */
function invokeTask(task: RunnableTask, ctx: unknown, data: unknown): void | Promise<void> {
  return task.hasData ? task.handler(ctx, data) : task.handler(ctx);
}

export async function handleScheduledAlarm(runtime: ScheduledRuntimeAccess): Promise<void> {
  const now = Date.now();
  const scheduledRuns = runtime.getScheduledRuns();
  const due = [...scheduledRuns.values()].filter((run) => run.time <= now);

  if (due.length === 0) {
    runtime.logger.info('[livething] scheduler alarm fired — nothing due', {
      queuedRuns: scheduledRuns.size,
    });
    runtime.rescheduleAlarm();
    return;
  }

  runtime.logger.info('[livething] scheduler alarm fired — running due tasks', {
    dueCount: due.length,
    dueTaskIds: due.map((run) => run.taskId),
    queuedAfter: scheduledRuns.size - due.length,
  });

  const claimed = getClaimedRunIds(runtime);
  for (const run of due) {
    scheduledRuns.delete(run.id);
    claimed.add(run.id);
  }

  // Delivery is at-least-once: the single persist at the end of this function
  // captures both the claim and the post-run state in one transaction. A DO
  // crash between claim and persist leaves the run row in storage, and the
  // next wake re-fires it. Matches Cloudflare Queues semantics; handlers must
  // be idempotent.
  //
  // A handler can call `ctx.schedule`/`ctx.cancelScheduled` on itself, which
  // persists immediately. `claimed` (above) keeps that write from deleting
  // this run's still-durable row while the handler is running — cleared just
  // before the persist below, so a genuinely finished run is deleted here as
  // normal.

  const results = await Promise.allSettled(
    due.map(async (run) => {
      const task = runtime.getScheduledTask(run.taskId);
      if (task?.handler) {
        const ctx = runtime.createTaskContext();
        const runnable: RunnableTask = {
          handler: task.handler as RunnableTask['handler'],
          hasData: task.hasData === true,
        };

        await (runtime.runInTaskContext
          ? runtime.runInTaskContext(ctx, () => invokeTask(runnable, ctx, run.data))
          : invokeTask(runnable, ctx, run.data));
      }

      return run;
    }),
  );

  const deadLetters = runtime.getScheduledDlq();
  // Read after the handlers settle: a handler may have stopped its own task.
  const stopped = due.some((run) => run.recurring)
    ? readStoppedTaskIds(runtime)
    : new Set<string>();

  for (const [index, result] of results.entries()) {
    const run = due[index];
    if (!run) continue;

    const requeueRecurring =
      run.recurring &&
      !!run.every &&
      !stopped.has(run.taskId) &&
      // Drop the recurring re-queue when the task was removed from the
      // handler between deploys. Without this guard the row keeps coming
      // back on every alarm tick and storage never shrinks.
      !!runtime.getScheduledTask(run.taskId) &&
      // A handler that stopped and then scheduled its own task already queued
      // the restarted cycle; do not add a second one.
      ![...scheduledRuns.values()].some(
        (queued) => queued.taskId === run.taskId && queued.recurring,
      );

    if (result.status === 'fulfilled') {
      if (requeueRecurring && run.every) {
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

    if (retryDelay !== undefined && !(run.recurring && stopped.has(run.taskId))) {
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

    if (requeueRecurring && run.every) {
      // A task with `every` cannot declare `data` — `scheduled({...})` rejects
      // the combination. The re-queue always has an undefined payload.
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

  claimed.clear();
  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
}

export interface ScheduleTaskRunOptions {
  taskId: string;

  time: number;

  data: unknown;
}

/**
 * Queue one future run of a scheduled task.
 *
 * This creates a one-shot run, even if the task also has a recurring `every`
 * schedule. The one exception is a recurring task stopped by
 * `cancelScheduledRuns`: scheduling it starts the recurring cycle again, with
 * the first run at `time` and one every `every` ms after that.
 */
export function scheduleTaskRun(
  runtime: ScheduledRuntimeAccess,
  options: ScheduleTaskRunOptions,
): void {
  const { taskId, time, data } = options;
  const task = runtime.getScheduledTask(taskId);
  if (!task) {
    throw new Error(`[livething] scheduled task "${taskId}" is not registered.`);
  }

  assertPositiveInteger(time, 'time', `ctx.schedule("${taskId}", ...)`);
  const id = runtime.generateId('task');

  let normalizedData = data;

  if (task.hasData) {
    normalizedData = validateValue(task.dataSchema, data, taskId);
  } else if (data !== undefined) {
    throw new Error(
      `[livething] ctx.schedule("${taskId}", ...) was given data, but task "${taskId}" declares no data. ` +
        `Declare it as { data: t<...>() } in scheduled({ ... }), or leave data out.`,
    );
  }

  // The task gets the data as it is stored, so it is the same before and after a restart. Data
  // that has no JSON throws here, before the run joins the queue.
  const storedData =
    normalizedData === undefined
      ? undefined
      : JSON.parse(serializeJsonOrThrow(normalizedData, `ctx.schedule("${taskId}", ...) data`));

  const every = task.options?.every;
  const restartsRecurring = every !== undefined && clearTaskStopped(runtime, taskId);

  runtime.getScheduledRuns().set(id, {
    id,
    taskId,
    time,
    data: storedData,
    ...(restartsRecurring ? { every } : {}),
    attempts: 0,
    recurring: restartsRecurring,
    retry: task.options?.retry ?? true,
  });

  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();
}

/**
 * Remove queued runs for one task id.
 *
 * With no filter, all one-shot runs are removed and recurring runs are stopped.
 * A stopped recurring task stays stopped across restarts and wakes until
 * `scheduleTaskRun` starts it again. With a filter, only one-shot runs whose
 * data matches the provided keys are removed.
 */
export function cancelScheduledRuns(
  runtime: ScheduledRuntimeAccess,
  taskId: string,
  filter?: Record<string, unknown>,
): ScheduledCancelResult {
  // Reject explicit-undefined filter values up front. Otherwise
  // `dataMatchesFilter` matches runs whose data is missing the key entirely,
  // which silently cancels the wrong runs.
  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) {
        throw new Error(
          `[livething] ctx.cancelScheduled("${taskId}", filter): filter key "${key}" is undefined. ` +
            `Pass a real value or omit the key — an undefined entry would match runs whose data has no "${key}" at all.`,
        );
      }
    }
  }

  const scheduledRuns = runtime.getScheduledRuns();
  const task = runtime.getScheduledTask(taskId);
  let removed = 0;
  let removedRecurring = false;

  for (const [id, run] of scheduledRuns) {
    if (run.taskId !== taskId) continue;

    if (run.recurring) {
      if (!filter) {
        scheduledRuns.delete(id);
        removed += 1;
        removedRecurring = true;
      }

      continue;
    }

    if (dataMatchesFilter(run.data, filter)) {
      scheduledRuns.delete(id);
      removed += 1;
    }
  }

  // Stopping counts as a removal even when no recurring run was queued — for
  // example when the task cancels itself while its own run is in progress.
  if (!filter && task?.options?.every && markTaskStopped(runtime, taskId) && !removedRecurring) {
    removed += 1;
  }

  persistSchedulerState(runtime);
  runtime.rescheduleAlarm();

  return { taskExists: !!task, removed };
}
