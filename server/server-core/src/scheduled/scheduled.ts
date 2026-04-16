/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from '~/_engine/access.ts';
import type { TaskContext } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';
import { bootstrapScheduledRuntime, handleScheduledAlarm } from './runtime.ts';
import type { ScheduledRuntimeAccess } from './types.ts';

/** Options accepted by the `scheduled()` factory. */
export interface ScheduledOptions<TData = unknown> {
  /**
   * Optional schema validator for the task's data payload. Use this when you
   * declare a task with a schema instead of a handler, or when you want the
   * engine to validate task data provided at enqueue time.
   */
  readonly data?: Validator<TData>;

  /**
   * Repeat interval in milliseconds. When set, the engine automatically
   * re-schedules the task after each successful run.
   */
  readonly every?: number;

  /**
   * Controls retry behaviour for failed task runs.
   *
   * - `true` (default) — retries with the default backoff schedule
   *   `[1_000, 5_000, 25_000]` ms, then dead-letters.
   * - `false` — no retries; failures go straight to the dead-letter queue.
   * - `number[]` — custom backoff schedule in milliseconds. The array length
   *   determines the maximum number of retry attempts (e.g. `[50, 100]` means
   *   retry at most twice with 50 ms and 100 ms delays).
   */
  readonly retry?: boolean | readonly number[];
}

/**
 * An opaque handle returned when a task is enqueued. Pass this to the
 * scheduled task API (e.g. `ctx.scheduleTask`) to cancel or inspect the task.
 *
 * `__data` is a phantom type field (never at runtime) that carries the task's
 * data type for type-checking at the call site.
 */
export interface ScheduledHandle<TData = unknown> {
  /** The unique ID of this scheduled task instance. */
  readonly id: string;
  /** Phantom type field — not present at runtime. */
  readonly __data?: TData;
}

/**
 * The function signature for a scheduled task handler. Called when the task
 * fires.
 *
 * @param ctx  The task execution context (subset of the connection context).
 * @param data The validated task data payload.
 */
export type ScheduledHandler<TCtx = TaskContext, TData = unknown> = (
  ctx: TCtx,
  data: TData,
) => void | Promise<void>;

/**
 * The primitive type produced by `scheduled()`. Carries the task ID, optional
 * handler, optional data schema, and options so the engine can register the
 * task in its scheduler.
 */
export interface ScheduledPrimitive<
  TTaskId extends string = string,
  TData = unknown,
  TCtx = any,
> extends Primitive<'scheduled'> {
  /** The unique identifier for this task. */
  readonly taskId: TTaskId;
  /** The handler to run when the task fires, if provided at registration time. */
  readonly handler?: ScheduledHandler<TCtx, TData>;
  /** Schema validator for the task data, if provided at registration time. */
  readonly dataSchema?: Validator<TData>;
  /** Recurrence and retry configuration. */
  readonly options?: ScheduledOptions<TData>;
}

/** Unique symbol. The registration ID is the task ID, so each task is its own singleton. */
const SCHEDULED_KEY = Symbol('scheduled');

/**
 * Internal singleton key: the scheduled runtime (SQLite tables, alarm wiring)
 * is installed only once per engine regardless of how many task primitives are
 * registered.
 */
export const SCHEDULED_RUNTIME_KEY = Symbol('scheduled-runtime');

/** Overload: register a task with an inline handler function. */
export function scheduled<TTaskId extends string, TData, TCtx>(
  taskId: TTaskId,
  handler: ScheduledHandler<TCtx, TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData, TCtx>;
/** Overload: declare a task with a schema only (no inline handler). */
export function scheduled<TTaskId extends string, TData>(
  taskId: TTaskId,
  dataSchema: Validator<TData>,
  options?: ScheduledOptions<TData>,
): ScheduledPrimitive<TTaskId, TData>;
/**
 * Creates a scheduled task primitive. Registers a named background task with
 * the engine's scheduler. The second argument is either:
 *
 * - A **handler function** — runs when the task fires.
 * - A **Standard Schema validator** — declares the task without attaching a
 *   handler here (useful for shared task contracts that are handled elsewhere).
 *
 * The two forms are distinguished at runtime by checking whether the second
 * argument has the `~standard` key that Standard Schema validators carry.
 *
 * Requires the `storage` and `timers` platform capabilities.
 *
 * @example
 * ```ts
 * import '@wskit/server/scheduled';
 *
 * server('chat')
 *   .scheduled('send-digest', async (ctx, data: { userId: string }) => {
 *     await sendEmail(data.userId);
 *   }, { every: 24 * 60 * 60 * 1000 });
 * ```
 */
export function scheduled(
  taskId: string,
  handlerOrSchema: ScheduledHandler | Validator,
  options?: ScheduledOptions,
): ScheduledPrimitive {
  // Standard Schema validators carry a `~standard` key. Anything else is a handler function.
  const isHandler =
    typeof handlerOrSchema === 'function' && !('~standard' in (handlerOrSchema as object));

  return {
    __wskit: 'scheduled',
    __kind: 'infrastructure',
    __identity: [SCHEDULED_KEY, taskId],
    __dependencies: [],
    __requires: { storage: true, timers: true },
    taskId,
    handler: isHandler ? (handlerOrSchema as ScheduledHandler) : undefined,
    dataSchema: isHandler ? options?.data : (handlerOrSchema as Validator),
    options,
    __setup(engine: EngineAccess) {
      // Bootstrap the scheduler tables and alarm handler once, no matter how
      // many task primitives are registered.
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

        engine.onBoot(() => {
          bootstrapScheduledRuntime(runtime);
        });

        engine.onAlarm(async () => {
          await handleScheduledAlarm(runtime);
        });
      });
    },
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
scheduled.__key = SCHEDULED_KEY;
