/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';
import type { TypeMarker } from '~/t.ts';
import { bootstrapScheduledRuntime, handleScheduledAlarm } from './runtime.ts';
import type { ScheduledRuntimeAccess } from './types.ts';

/**
 * Options for one scheduled task declaration.
 *
 * These options belong to the task definition itself, not to one specific
 * queued run created later with `ctx.schedule(...)`.
 */
export interface ScheduledOptions<TData = unknown> {
  /**
   * Compile-time marker for the task payload shape.
   *
   * Use this when you want the handler form to declare its data type through
   * the options object instead of through an explicit parameter annotation.
   * This marker is used for typing only and is not read at runtime.
   */
  readonly data?: TypeMarker<TData>;

  /**
   * Run this task on a fixed interval, in milliseconds.
   *
   * Example:
   * - `every: 60_000` means "run every minute"
   *
   * The first recurring run is scheduled one interval after the handler starts.
   * One-shot runs scheduled later with `ctx.schedule(...)` stay one-shot and do
   * not change the recurring schedule.
   */
  readonly every?: number;

  /**
   * Whether failed runs should be retried automatically.
   *
   * Default: `true`
   *
   * Retry backoff is fixed by the framework:
   * - 1st retry after 1 second
   * - 2nd retry after 5 seconds
   * - 3rd retry after 25 seconds
   *
   * After that, or immediately when `retry: false`, the failed run is moved to
   * the scheduler's internal dead-letter queue (DLQ).
   */
  readonly retry?: boolean;
}

export interface ScheduledHandle<TData = unknown> {
  readonly id: string;
  readonly __data?: TData;
}

export type ScheduledHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data: TData,
) => void | Promise<void>;

/**
 * The primitive instance returned by `scheduled()`.
 *
 * A scheduled primitive does two jobs:
 * 1. it declares one named task in the server definition
 * 2. it can optionally provide the handler that should run when that task fires
 */
export interface ScheduledPrimitive<
  TTaskId extends string = string,
  TData = unknown,
  TCtx = any,
> extends Primitive<'scheduled'> {
  readonly taskId: TTaskId;
  readonly handler?: ScheduledHandler<TCtx, TData>;
  readonly data?: TypeMarker<TData>;
  readonly options?: ScheduledOptions<TData>;
}

const SCHEDULED_KEY = Symbol('scheduled');
const SCHEDULED_RUNTIME_KEY = Symbol('scheduled-runtime');

const _scheduled = definePrimitive<
  'scheduled',
  [
    taskId: string,
    handlerOrData: ScheduledHandler | TypeMarker<any>,
    options?: ScheduledOptions<any>,
  ],
  {
    taskId: string;
    handler?: ScheduledHandler;
    data?: TypeMarker<any>;
    options?: ScheduledOptions<any>;
  }
>({
  tag: 'scheduled' as const,
  key: SCHEDULED_KEY,
  kind: 'infrastructure' as const,
  registrationId(taskId: string) {
    return taskId;
  },
  requires: {
    storage: true,
    timers: true,
  },
  create(
    taskId: string,
    handlerOrData: ScheduledHandler | TypeMarker<any>,
    options?: ScheduledOptions<any>,
  ) {
    if (typeof handlerOrData === 'function') {
      return {
        taskId,
        handler: handlerOrData,
        data: options?.data,
        options,
      };
    }

    return {
      taskId,
      data: handlerOrData,
      options,
    };
  },
  setup(engine) {
    engine.installOnce(SCHEDULED_RUNTIME_KEY, () => {
      const runtime: ScheduledRuntimeAccess = {
        requireStorage: () => engine.requireStorage(),
        requireTimers: () => engine.requireTimers(),
        generateId: (prefix?: string) => engine.generateId(prefix),
        getScheduledRuns: () => engine.getScheduledRuns(),
        getScheduledDlq: () => engine.getScheduledDlq(),
        getScheduledTask: (taskId: string) => engine.getScheduledTask(taskId),
        getScheduledTasks: () => engine.getScheduledTasks(),
        createTaskContext: () => engine.createTaskContext(),
        rescheduleAlarm: () => engine.rescheduleAlarm(),
      };

      // Restore persisted task runs before normal init hooks begin.
      engine.onBoot(() => {
        bootstrapScheduledRuntime(runtime);
      });

      // When the adapter wakes the engine for an alarm, let scheduled own the
      // due-task execution logic.
      engine.onAlarm(async () => {
        await handleScheduledAlarm(runtime);
      });
    });
  },
});

/**
 * Register a named scheduled task.
 *
 * Use the handler form for real work, or the `t<...>()` form when you only
 * want to declare the task's data shape.
 */
export function scheduled<TTaskId extends string, TData, TCtx>(
  taskId: TTaskId,
  handler: ScheduledHandler<TCtx, TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData, TCtx>;
export function scheduled<TTaskId extends string, TData>(
  taskId: TTaskId,
  data: TypeMarker<TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData>;
export function scheduled(
  taskId: string,
  handlerOrData: ScheduledHandler<any, any> | TypeMarker<any>,
  options?: ScheduledOptions<any>,
): ScheduledPrimitive {
  return _scheduled(taskId, handlerOrData, options) as ScheduledPrimitive;
}

/** Dependency ref — use in `dependencies: [scheduled]` to assert it's registered. */
scheduled.__key = SCHEDULED_KEY;
