/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.scheduled()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/scheduled'`
 * Adds method: `.scheduled(taskId, handlerOrSchema, options?)`
 *
 * Calling `.scheduled()` registers a background task that the server can run on
 * a schedule or on demand. The second argument is either a handler function
 * (runs immediately when triggered) or a Standard Schema validator (defers
 * handling to runtime dispatch — useful when declaring a task without
 * attaching a handler in the same file).
 *
 * Requires the `storage` and `timers` platform capabilities.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 * The `any` suppressions are needed because the two overloads share a single
 * prototype implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type {
  ScheduledHandler,
  ScheduledOptions,
  ScheduledPrimitive,
} from '~/scheduled/scheduled.ts';
import type { Validator } from '~/types.ts';

/**
 * Module augmentation: adds `.scheduled()` to the builder interfaces so
 * TypeScript recognises both overloads after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register a scheduled task with an inline handler.
     *
     * @param taskId   Unique name for this task — used to trigger or cancel it.
     * @param handler  Function to call when the task fires.
     * @param options  Optional recurrence interval, data validator, and retry flag.
     */
    scheduled<TTaskId extends string, TData, TCtx>(
      taskId: TTaskId,
      handler: ScheduledHandler<TCtx, TData>,
      options?: ScheduledOptions<TData>,
    ): ServerBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData, TCtx>>>;

    /**
     * Declare a scheduled task without attaching a handler here.
     * Provide a schema so the engine can validate task data at runtime.
     *
     * @param taskId     Unique name for this task.
     * @param dataSchema Standard Schema validator for the task payload.
     * @param options    Optional recurrence interval and retry flag.
     */
    scheduled<TTaskId extends string, TData>(
      taskId: TTaskId,
      dataSchema: Validator<TData>,
      options?: ScheduledOptions<TData>,
    ): ServerBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register a scheduled task with an inline handler.
     *
     * @param taskId   Unique name for this task.
     * @param handler  Function to call when the task fires.
     * @param options  Optional recurrence interval, data validator, and retry flag.
     */
    scheduled<TTaskId extends string, TData, TCtx>(
      taskId: TTaskId,
      handler: ScheduledHandler<TCtx, TData>,
      options?: ScheduledOptions<TData>,
    ): GroupBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData, TCtx>>>;

    /**
     * Declare a scheduled task without attaching a handler here.
     *
     * @param taskId     Unique name for this task.
     * @param dataSchema Standard Schema validator for the task payload.
     * @param options    Optional recurrence interval and retry flag.
     */
    scheduled<TTaskId extends string, TData>(
      taskId: TTaskId,
      dataSchema: Validator<TData>,
      options?: ScheduledOptions<TData>,
    ): GroupBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData>>>;
  }
}

/**
 * Runtime implementation of `.scheduled()` for `ServerBuilder`.
 *
 * Both overloads (handler and schema) are collapsed into a single function here
 * — `createScheduled` distinguishes them internally by checking whether the
 * second argument has the `~standard` key that Standard Schema validators carry.
 */
ServerBuilder.prototype.scheduled = function (
  this: ServerBuilder<any>,
  taskId: string,
  handlerOrSchema: any,
  options?: any,
) {
  this._primitives.push(createScheduled(taskId, handlerOrSchema, options));
  return this;
};

/** Runtime implementation of `.scheduled()` for `GroupBuilder`. */
GroupBuilder.prototype.scheduled = function (
  this: GroupBuilder<any>,
  taskId: string,
  handlerOrSchema: any,
  options?: any,
) {
  this._primitives.push(createScheduled(taskId, handlerOrSchema, options));
  return this;
};
