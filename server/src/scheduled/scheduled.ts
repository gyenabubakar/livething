/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { TaskContext } from '~/context.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * Options accepted by scheduled tasks.
 *
 * `retry` supports:
 * - `true`  — default backoff
 * - `false` — no retries
 * - `number[]` — custom backoff schedule in milliseconds
 */
export interface ScheduledOptions {
  readonly every?: number;
  readonly retry?: boolean | readonly number[];
}

/**
 * An opaque handle returned when a task is enqueued.
 *
 * `__data` exists only so TypeScript can remember the task's payload type.
 * It is not present at runtime.
 */
export interface ScheduledHandle<TData = unknown> {
  /** The unique ID of this scheduled task instance. */
  readonly id: string;
  /** Type-only field — not present at runtime. */
  readonly __data?: TData;
}

/** A scheduled task handler for tasks that do not declare `.data(...)`. */
export type ScheduledHandlerNoData<TCtx = TaskContext> = (ctx: TCtx) => void | Promise<void>;

/** A scheduled task handler for tasks that declare `.data(...)`. */
export type ScheduledHandlerWithData<TCtx = TaskContext, TData = unknown> = (
  ctx: TCtx,
  data: TData,
) => void | Promise<void>;

/** The handler type stored on a scheduled primitive. */
export type ScheduledHandler<
  TCtx = TaskContext,
  TData = unknown,
  THasData extends boolean = true,
> = THasData extends true ? ScheduledHandlerWithData<TCtx, TData> : ScheduledHandlerNoData<TCtx>;

/**
 * The primitive type produced by `scheduled()`.
 *
 * `hasData` tells the runtime whether the handler should be invoked as
 * `handler(ctx)` or `handler(ctx, data)`.
 */
export interface ScheduledPrimitive<
  TTaskId extends string = string,
  TData = never,
  THasData extends boolean = false,
  TCtx = any,
> extends Primitive<'scheduled'> {
  readonly taskId: TTaskId;
  readonly handler: ScheduledHandler<TCtx, TData, THasData>;
  readonly hasData: THasData;
  readonly dataSchema?: THasData extends true ? Validator<TData> : undefined;
  readonly options?: ScheduledOptions;
}

/** Unique symbol. The registration ID is the task ID, so each task is its own singleton. */
const SCHEDULED_KEY = Symbol('scheduled');

/**
 * Internal singleton key: the scheduled runtime (SQLite tables, alarm wiring)
 * is installed only once per engine regardless of how many task primitives are
 * registered.
 *
 * @internal
 */
export const SCHEDULED_RUNTIME_KEY = Symbol('scheduled-runtime');

/**
 * Fluent builder for defining one scheduled task.
 *
 * Tasks start in the "no data" state. Calling `.data(schema)` upgrades the
 * builder so `.run(...)` receives a validated `data` argument and
 * `ctx.schedule(...)` later requires matching payload.
 */
export class ScheduledBuilder<
  TTaskId extends string,
  TCtx = TaskContext,
  TData = never,
  THasData extends boolean = false,
  THasRun extends boolean = false,
> {
  readonly _taskId: TTaskId;
  declare readonly _hasData: THasData;
  declare readonly _hasRun: THasRun;
  _dataSchema?: Validator<TData>;
  _options: ScheduledOptions = {};
  _handler?: ScheduledHandler<TCtx, TData, THasData>;

  constructor(taskId: TTaskId) {
    this._taskId = taskId;
  }

  /** Declare the payload schema required when the task is enqueued. */
  data<TNextData>(
    dataSchema: Validator<TNextData>,
  ): ScheduledBuilder<TTaskId, TCtx, TNextData, true, THasRun> {
    this._dataSchema = dataSchema as unknown as Validator<TData>;
    return this as unknown as ScheduledBuilder<TTaskId, TCtx, TNextData, true, THasRun>;
  }

  /** Schedule this task to repeat at the given interval in milliseconds. */
  every(
    this: THasData extends true
      ? undefined extends TData
        ? ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun>
        : never
      : ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun>,
    everyMs: number,
  ): this {
    this._options = { ...this._options, every: everyMs };
    return this as unknown as this;
  }

  /** Configure retry behaviour: default backoff, no retry, or custom backoff. */
  retry(
    retry: ScheduledOptions['retry'],
  ): ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun> {
    this._options = { ...this._options, retry };
    return this;
  }

  /** Finalize the task and attach the handler. */
  run(
    this: ScheduledBuilder<TTaskId, TCtx, TData, THasData, false>,
    handler: THasData extends true
      ? (ctx: TCtx, data: TData) => void | Promise<void>
      : (ctx: TCtx) => void | Promise<void>,
  ): ScheduledBuilder<TTaskId, TCtx, TData, THasData, true> {
    this._handler = handler as ScheduledHandler<TCtx, TData, THasData>;
    return this as unknown as ScheduledBuilder<TTaskId, TCtx, TData, THasData, true>;
  }

  /** @internal Convert the finalized builder state into a scheduled primitive. */
  _build(
    this: ScheduledBuilder<TTaskId, TCtx, TData, THasData, true>,
  ): ScheduledPrimitive<TTaskId, TData, THasData, TCtx> {
    return {
      __wskit: 'scheduled',
      __kind: 'infrastructure',
      __identity: [SCHEDULED_KEY, this._taskId],
      __dependencies: [],
      __requires: { storage: true, timers: true },
      taskId: this._taskId,
      handler: this._handler as ScheduledHandler<TCtx, TData, THasData>,
      hasData: Boolean(this._dataSchema) as THasData,
      dataSchema: this._dataSchema as ScheduledPrimitive<
        TTaskId,
        TData,
        THasData,
        TCtx
      >['dataSchema'],
      options:
        this._options.every === undefined && this._options.retry === undefined
          ? undefined
          : this._options,
    };
  }
}

/**
 * Register a scheduled task with the fluent scheduled builder.
 *
 * @example
 * ```ts
 * server('chat').scheduled('cleanup', (t) =>
 *   t.retry(false).run((ctx) => {
 *     ctx.broadcast('cleanup-done', { at: Date.now() });
 *   }),
 * );
 *
 * server('chat').scheduled('send-to-conn', (t) =>
 *   t
 *     .data(v.object({ connectionId: v.string(), text: v.string() }))
 *     .retry([50, 100])
 *     .run((ctx, data) => {
 *       ctx.sendToConnection(data.connectionId, 'message', { text: data.text });
 *     }),
 * );
 * ```
 */
export function scheduled<
  TTaskId extends string,
  TCtx = TaskContext,
  TData = never,
  THasData extends boolean = false,
>(
  taskId: TTaskId,
  callback: (
    builder: ScheduledBuilder<TTaskId, TCtx>,
  ) => ScheduledBuilder<TTaskId, TCtx, TData, THasData, true>,
): ScheduledPrimitive<TTaskId, TData, THasData, TCtx> {
  const builder = new ScheduledBuilder<TTaskId, TCtx>(taskId);
  const finalized =
    callback(builder) ??
    (builder as unknown as ScheduledBuilder<TTaskId, TCtx, TData, THasData, true>);

  if (!finalized._handler) {
    throw new Error(`[wskit] scheduled("${taskId}") must call .run(...) before returning.`);
  }

  return finalized._build();
}

/** Symbol key used to reference this primitive in dependency declarations. */
scheduled.__key = SCHEDULED_KEY;
