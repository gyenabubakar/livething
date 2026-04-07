/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';
import type { TypeMarker } from '~/t.ts';

export interface ScheduledOptions {
  readonly every?: number;
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
 * This declares a named scheduled task and, optionally, the handler that runs
 * when the task fires.
 */
export interface ScheduledPrimitive<
  TTaskId extends string = string,
  TData = unknown,
  TCtx = any,
> extends Primitive<'scheduled'> {
  readonly taskId: TTaskId;
  readonly handler?: ScheduledHandler<TCtx, TData>;
  readonly data?: TypeMarker<TData>;
  readonly options?: ScheduledOptions;
}

const SCHEDULED_KEY = Symbol('scheduled');

const _scheduled = definePrimitive<
  'scheduled',
  [taskId: string, handlerOrData: ScheduledHandler | TypeMarker<any>, options?: ScheduledOptions],
  {
    taskId: string;
    handler?: ScheduledHandler;
    data?: TypeMarker<any>;
    options?: ScheduledOptions;
  }
>({
  tag: 'scheduled' as const,
  key: SCHEDULED_KEY,
  kind: 'infrastructure' as const,
  registrationId(taskId: string) {
    return taskId;
  },
  requires: {
    timers: true,
  },
  create(
    taskId: string,
    handlerOrData: ScheduledHandler | TypeMarker<any>,
    options?: ScheduledOptions,
  ) {
    if (typeof handlerOrData === 'function') {
      return {
        taskId,
        handler: handlerOrData,
        options,
      };
    }

    return {
      taskId,
      data: handlerOrData,
      options,
    };
  },
});

/**
 * Register a named scheduled task.
 *
 * Use the handler form for real work, or the `t<...>()` form when you only
 * want to declare the task's data shape.
 */
export function scheduled<TTaskId extends string, TCtx>(
  taskId: TTaskId,
  handler: ScheduledHandler<TCtx, unknown>,
  options?: ScheduledOptions,
): ScheduledPrimitive<TTaskId, unknown, TCtx>;
export function scheduled<TTaskId extends string, TData, TCtx>(
  taskId: TTaskId,
  handler: ScheduledHandler<TCtx, TData>,
  options?: ScheduledOptions,
): ScheduledPrimitive<TTaskId, TData, TCtx>;
export function scheduled<TTaskId extends string, TData>(
  taskId: TTaskId,
  data: TypeMarker<TData>,
  options?: ScheduledOptions,
): ScheduledPrimitive<TTaskId, TData>;
export function scheduled(
  taskId: string,
  handlerOrData: ScheduledHandler<any, any> | TypeMarker<any>,
  options?: ScheduledOptions,
): ScheduledPrimitive {
  return _scheduled(taskId, handlerOrData, options) as ScheduledPrimitive;
}

/** Dependency ref — use in `dependencies: [scheduled]` to assert it's registered. */
scheduled.__key = SCHEDULED_KEY;
