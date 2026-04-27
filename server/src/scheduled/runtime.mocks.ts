import type { SqlResult } from '~/context.ts';
import type { scheduled } from './scheduled.ts';
import type { ScheduledDeadLetter, ScheduledRun, ScheduledRuntimeAccess } from './types.ts';

/**
 * Tiny in-memory `SqlResult` used by scheduled-runtime tests.
 *
 * It implements only the methods the scheduled runtime reads, so the tests can
 * stay fast and avoid spinning up a real database.
 */
export class FakeSqlResult<TRow = unknown> implements SqlResult<TRow> {
  constructor(private readonly rows: TRow[]) {}

  toArray(): TRow[] {
    return [...this.rows];
  }

  one(): TRow | null {
    if (this.rows.length === 0) return null;
    if (this.rows.length > 1) {
      throw new Error('one() expected at most one row, but the cursor has multiple');
    }
    return this.rows[0] ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row as Record<string, unknown>));
  }
}

/**
 * In-memory stand-in for the SQL provider used by scheduled-runtime tests.
 *
 * It recognizes the handful of SQL statements emitted by the runtime and maps
 * them onto plain JavaScript `Map`s so tests can inspect scheduled rows and
 * dead-letter rows directly.
 */
export class FakeSqlProvider {
  scheduled = new Map<
    string,
    {
      id: string;
      taskId: string;
      time: number;
      data: string | null;
      everyMs: number | null;
      attempts: number;
      recurring: number;
      retry: number;
    }
  >();

  scheduledDlq = new Map<
    string,
    {
      id: string;
      taskId: string;
      time: number;
      failedAt: number;
      data: string | null;
      attempts: number;
      error: string;
    }
  >();

  exec<TRow = unknown>(query: string, ...params: unknown[]): FakeSqlResult<TRow> {
    const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled_dlq')) {
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled')) {
      return new FakeSqlResult<TRow>([]);
    }

    if (
      normalizedQuery.startsWith(
        'SELECT id, taskId, time, data, everyMs, attempts, recurring, retry FROM _wskit_scheduled',
      )
    ) {
      return new FakeSqlResult<TRow>([...this.scheduled.values()] as TRow[]);
    }

    if (
      normalizedQuery.startsWith(
        'SELECT id, taskId, time, failedAt, data, attempts, error FROM _wskit_scheduled_dlq',
      )
    ) {
      return new FakeSqlResult<TRow>([...this.scheduledDlq.values()] as TRow[]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled_dlq')) {
      this.scheduledDlq.clear();
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled')) {
      this.scheduled.clear();
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('INSERT INTO _wskit_scheduled ')) {
      this.scheduled.set(String(params[0]), {
        id: String(params[0]),
        taskId: String(params[1]),
        time: Number(params[2]),
        data: (params[3] as string | null) ?? null,
        everyMs: (params[4] as number | null) ?? null,
        attempts: Number(params[5]),
        recurring: Number(params[6]),
        retry: Number(params[7]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    if (normalizedQuery.startsWith('INSERT INTO _wskit_scheduled_dlq')) {
      this.scheduledDlq.set(String(params[0]), {
        id: String(params[0]),
        taskId: String(params[1]),
        time: Number(params[2]),
        failedAt: Number(params[3]),
        data: (params[4] as string | null) ?? null,
        attempts: Number(params[5]),
        error: String(params[6]),
      });
      return new FakeSqlResult<TRow>([]);
    }

    return new FakeSqlResult<TRow>([]);
  }

  transaction<T>(
    fn: (tx: {
      exec<TRow = unknown>(query: string, ...params: unknown[]): FakeSqlResult<TRow>;
    }) => T,
  ): T {
    return fn({ exec: this.exec.bind(this) });
  }
}

/**
 * Build a fully in-memory scheduled runtime for unit tests.
 *
 * The returned object exposes the fake SQL layer plus a few inspection helpers
 * so tests can assert what got scheduled, what landed in the DLQ, and whether
 * alarms were rescheduled.
 */
export function createRuntime(tasksInput: ReturnType<typeof scheduled>[]) {
  const sql = new FakeSqlProvider();
  const scheduledRuns = new Map<string, ScheduledRun>();
  const scheduledDlq = new Map<string, ScheduledDeadLetter>();
  const tasks = new Map(tasksInput.map((task) => [task.taskId, task]));
  const alarmTimes: number[] = [];
  let nextId = 1;
  let rescheduleCount = 0;

  const runtime: ScheduledRuntimeAccess = {
    requireStorage: () => ({
      sql,
      kv: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
        async list() {
          return [];
        },
      },
    }),
    requireTimers: () => ({
      async setAlarm(timeMs: number) {
        alarmTimes.push(timeMs);
      },
      async deleteAlarm() {},
      async getAlarm() {
        return alarmTimes.at(-1) ?? null;
      },
      setTimeout() {
        return Symbol('timeout');
      },
      clearTimeout() {},
    }),
    generateId(prefix = 'id') {
      return `${prefix}-${nextId++}`;
    },
    getScheduledRuns: () => scheduledRuns,
    getScheduledDlq: () => scheduledDlq,
    getScheduledTask: (taskId) => tasks.get(taskId),
    getScheduledTasks: () => tasks.values(),
    createTaskContext: () => ({ kind: 'task-context' }),
    rescheduleAlarm: () => {
      rescheduleCount += 1;
    },
  };

  return {
    runtime,
    sql,
    scheduledRuns,
    scheduledDlq,
    alarmTimes,
    getRescheduleCount: () => rescheduleCount,
  };
}
