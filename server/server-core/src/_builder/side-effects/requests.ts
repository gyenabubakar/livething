/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EventContract } from '~/event.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { NextState, HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';
import { request as createRequest } from '~/request/request.ts';
import { ServerBuilder, GroupBuilder } from '~/_builder/server-builder.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    reply<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => TResponse | Promise<TResponse>,
    ): ServerBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    reply<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (ctx: HandlerCtxFromState<TState>, payload: TPayload) => TResponse | Promise<TResponse>,
    ): GroupBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }
}

ServerBuilder.prototype.reply = function (this: ServerBuilder<any>, eventContract: EventContract, _responseSchema: Validator, handler: any) {
  this._primitives.push(
    (createRequest as any)(eventContract.event, handler, { validator: eventContract.schema }) as Primitive,
  );
  return this;
};

GroupBuilder.prototype.reply = function (this: GroupBuilder<any>, eventContract: EventContract, _responseSchema: Validator, handler: any) {
  this._primitives.push(
    (createRequest as any)(eventContract.event, handler, { validator: eventContract.schema }) as Primitive,
  );
  return this;
};
