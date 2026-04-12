/* oxlint-disable @typescript-eslint/no-explicit-any */
import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { intercept as createIntercept } from '~/intercept/intercept.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { InterceptMessage } from '~/intercept/intercept.ts';
import type { Primitive } from '~/primitive.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    intercept(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        message: InterceptMessage,
      ) => InterceptMessage | void | Promise<InterceptMessage | void>,
    ): ServerBuilder<TState>;

    intercept<TEvent extends string>(
      event: TEvent,
      handler: (ctx: HandlerCtxFromState<TState>, payload: any) => any,
    ): ServerBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    intercept(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        message: InterceptMessage,
      ) => InterceptMessage | void | Promise<InterceptMessage | void>,
    ): GroupBuilder<TState>;

    intercept<TEvent extends string>(
      event: TEvent,
      handler: (ctx: HandlerCtxFromState<TState>, payload: any) => any,
    ): GroupBuilder<TState>;
  }
}

ServerBuilder.prototype.intercept = function (
  this: ServerBuilder<any>,
  firstArg: any,
  secondArg?: any,
) {
  if (typeof firstArg === 'string') {
    this._primitives.push(createIntercept(firstArg, secondArg) as unknown as Primitive);
  } else {
    this._primitives.push(createIntercept(firstArg) as unknown as Primitive);
  }
  return this;
};

GroupBuilder.prototype.intercept = function (
  this: GroupBuilder<any>,
  firstArg: any,
  secondArg?: any,
) {
  if (typeof firstArg === 'string') {
    this._primitives.push(createIntercept(firstArg, secondArg) as unknown as Primitive);
  } else {
    this._primitives.push(createIntercept(firstArg) as unknown as Primitive);
  }
  return this;
};
