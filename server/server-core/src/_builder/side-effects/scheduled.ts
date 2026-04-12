/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ScheduledPrimitive, ScheduledHandler, ScheduledOptions } from '~/scheduled/scheduled.ts';
import type { Validator } from '~/types.ts';
import type { NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import { scheduled as createScheduled } from '~/scheduled/scheduled.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    scheduled<TTaskId extends string, TData, TCtx>(
      taskId: TTaskId,
      handler: ScheduledHandler<TCtx, TData>,
      options?: ScheduledOptions<TData>,
    ): ServerBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData, TCtx>>>;

    scheduled<TTaskId extends string, TData>(
      taskId: TTaskId,
      dataSchema: Validator<TData>,
      options?: ScheduledOptions<TData>,
    ): ServerBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    scheduled<TTaskId extends string, TData, TCtx>(
      taskId: TTaskId,
      handler: ScheduledHandler<TCtx, TData>,
      options?: ScheduledOptions<TData>,
    ): GroupBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData, TCtx>>>;

    scheduled<TTaskId extends string, TData>(
      taskId: TTaskId,
      dataSchema: Validator<TData>,
      options?: ScheduledOptions<TData>,
    ): GroupBuilder<NextState<TState, ScheduledPrimitive<TTaskId, TData>>>;
  }
}

ServerBuilder.prototype.scheduled = function (this: ServerBuilder<any>, taskId: string, handlerOrSchema: any, options?: any) {
  this._primitives.push(createScheduled(taskId, handlerOrSchema, options));
  return this;
};

GroupBuilder.prototype.scheduled = function (this: GroupBuilder<any>, taskId: string, handlerOrSchema: any, options?: any) {
  this._primitives.push(createScheduled(taskId, handlerOrSchema, options));
  return this;
};
