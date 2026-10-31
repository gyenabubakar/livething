import type { AnyScheduled } from '~/_engine/compile/types.ts';
import type { Logger, StorageProvider } from '~/context.ts';

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
  attempts: number;
  recurring: boolean;
  retry: boolean | readonly number[];
}

/**
 * One dead-lettered scheduled run.
 *
 * A run is moved here when it fails and the scheduler decides not to run it
 * again.
 */
export interface ScheduledDeadLetter {
  id: string;
  taskId: string;
  time: number;
  failedAt: number;
  data: unknown;
  attempts: number;
  error: {
    message: string;
    name?: string;
    stack?: string;
  };
}

/**
 * The small runtime surface the scheduled primitive needs from the engine.
 *
 * The engine still owns shared state like the in-memory run table. The
 * scheduled primitive uses this access object to read that state and
 * perform its own scheduling logic.
 */
export interface ScheduledRuntimeAccess {
  /** Read the adapter's SQL and key-value storage. */
  getStorage(): StorageProvider;

  /** Create a framework-generated id, usually for one queued task run. */
  generateId(prefix?: string): string;

  /** Read the engine-owned in-memory table of queued runs. */
  getScheduledRuns(): Map<string, ScheduledRun>;

  /**
   * Read the engine-owned mirror of the durable run table. Maps row id to a
   * stable signature of the columns last written. Used by the diff-based
   * persist to skip unchanged rows. Caller owns the map and updates it after
   * every successful write.
   */
  getScheduledRunsPersisted(): Map<string, string>;

  /** Read one declared scheduled task by its task id. */
  getScheduledTask(taskId: string): AnyScheduled | undefined;

  /** Read every declared scheduled task. */
  getScheduledTasks(): Iterable<AnyScheduled>;

  /** Build the context object passed to a scheduled task handler. */
  createContext(): unknown;

  /** Run a task handler so `context.task(base)` can reach `ctx`. Omitted by test harnesses. */
  runInTaskCall?<T>(ctx: unknown, fn: () => T): T;

  /** Ask the engine to recompute when the next alarm should fire. */
  rescheduleAlarm(): void;

  /** Adapter-provided structured logger. Used for scheduler boot/fire visibility. */
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}
