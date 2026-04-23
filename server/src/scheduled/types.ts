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

export interface ScheduledCancelResult {
  taskExists: boolean;
  removed: number;
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

  /** Read the engine-owned in-memory dead-letter queue. */
  getScheduledDlq(): Map<string, ScheduledDeadLetter>;

  /** Read one declared scheduled task by its task id. */
  getScheduledTask(taskId: string): AnyScheduled | undefined;

  /** Read every declared scheduled task. */
  getScheduledTasks(): Iterable<AnyScheduled>;

  /** Build the context object passed to a scheduled task handler. */
  createTaskContext(): unknown;

  /** Ask the engine to recompute when the next alarm should fire. */
  rescheduleAlarm(): void;
}
