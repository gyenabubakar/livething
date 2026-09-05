/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertPositiveInteger } from '~/_engine/validation.ts';
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

  /**
   * Declare the payload schema required when the task is enqueued.
   *
   * Cannot be combined with `.every(...)`. A recurring task is auto-seeded
   * by the engine and there is no caller to supply the payload, so a
   * schema that requires fields would crash at boot. Define recurring
   * tasks without `.data(...)` and read the inputs the task needs from
   * persistent state instead.
   */
  data<TNextData>(
    dataSchema: Validator<TNextData>,
  ): ScheduledBuilder<TTaskId, TCtx, TNextData, true, THasRun> {
    if (this._options.every !== undefined) {
      throw new Error(
        `[wskit] scheduled("${this._taskId}") cannot combine .data(...) with .every(...). Recurring tasks have no caller to supply the payload.`,
      );
    }
    this._dataSchema = dataSchema as unknown as Validator<TData>;
    return this as unknown as ScheduledBuilder<TTaskId, TCtx, TNextData, true, THasRun>;
  }

  /**
   * Schedule this task to repeat at the given interval in milliseconds.
   *
   * Must be a positive finite integer. Zero, negative, fractional, NaN, and
   * Infinity are rejected at registration — non-positive intervals would
   * silently drop the task or produce immediate-firing alarm churn.
   */
  every(
    this: THasData extends true
      ? undefined extends TData
        ? ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun>
        : never
      : ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun>,
    everyMs: number,
  ): this {
    assertPositiveInteger(everyMs, '.every(ms)', `scheduled("${this._taskId}")`);
    if (this._dataSchema !== undefined) {
      throw new Error(
        `[wskit] scheduled("${this._taskId}") cannot combine .every(...) with .data(...). Recurring tasks have no caller to supply the payload.`,
      );
    }
    this._options = { ...this._options, every: everyMs };
    return this as unknown as this;
  }

  /**
   * Configure retry behaviour: default backoff, no retry, or custom backoff.
   *
   * When passing a custom backoff array, every entry is the delay in
   * milliseconds before the next attempt. Each entry must be a positive
   * finite integer. Zero, negative, fractional, NaN, and Infinity are
   * rejected at registration — non-positive delays would re-fire the alarm
   * immediately or in the past, and NaN delays would corrupt the next-run
   * timestamp.
   */
  retry(
    retry: ScheduledOptions['retry'],
  ): ScheduledBuilder<TTaskId, TCtx, TData, THasData, THasRun> {
    if (Array.isArray(retry)) {
      if (retry.length === 0) {
        throw new Error('[wskit] .retry([...]) requires at least one entry.');
      }
      for (const entry of retry) {
        assertPositiveInteger(entry, '.retry([ms])', `scheduled("${this._taskId}")`);
      }
    }
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
    // Defense-in-depth guard. The .data() and .every() entry points
    // already throw when combined, but a primitive that bypasses the
    // builder must not slip a recurring + dataSchema task into the
    // engine. The recurring seed has no caller to supply a payload.
    if (this._dataSchema !== undefined && this._options.every !== undefined) {
      throw new Error(
        `[wskit] scheduled("${this._taskId}") cannot combine .data(...) with .every(...). Recurring tasks have no caller to supply the payload.`,
      );
    }
    return {
      __wskit: 'scheduled',
      __kind: 'infrastructure',
      __identity: [SCHEDULED_KEY, this._taskId],
      __requires: {},
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
 * Internal factory that builds a scheduled-task primitive from a fluent
 * builder callback. Durable stream capabilities use it for their internal
 * recurring work.
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

/**
 * Build a scheduled-task primitive directly from a declaration and a handler.
 *
 * The fluent `ScheduledBuilder` requires a Standard Schema to mark a task as
 * carrying data, which also validates it at enqueue time. This factory accepts
 * a separate `hasData` flag so a task can declare a data *type* (via `t<...>()`)
 * without a runtime validator — the server-side data is trusted and not
 * validated. It keeps the same identity and storage requirement as the builder.
 *
 * @internal
 */
export function makeScheduledPrimitive<TCtx = TaskContext>(
  taskId: string,
  declaration: { hasData: boolean; dataSchema?: Validator; options?: ScheduledOptions },
  handler: (ctx: TCtx, data?: unknown) => void | Promise<void>,
): ScheduledPrimitive<string, unknown, boolean, TCtx> {
  if (declaration.dataSchema !== undefined && declaration.options?.every !== undefined) {
    throw new Error(
      `[wskit] scheduled("${taskId}") cannot combine data with every. Recurring tasks have no caller to supply the payload.`,
    );
  }
  return {
    __wskit: 'scheduled',
    __kind: 'infrastructure',
    __identity: [SCHEDULED_KEY, taskId],
    __requires: {},
    taskId,
    handler: handler as ScheduledHandler<TCtx, unknown, boolean>,
    hasData: declaration.hasData,
    dataSchema: declaration.dataSchema as ScheduledPrimitive<
      string,
      unknown,
      boolean,
      TCtx
    >['dataSchema'],
    options: declaration.options,
  };
}
