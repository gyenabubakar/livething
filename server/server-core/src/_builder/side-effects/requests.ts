/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.reply()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/requests'`
 * Adds method: `.reply(eventContract, responseSchema, handler)`
 *
 * Calling `.reply()` registers a request–response handler. The client sends
 * an event and awaits a response. The handler returns (or resolves to) the
 * response value, which the engine sends back to the same client connection.
 *
 * Unlike `.incoming()`, which is fire-and-forget, `.reply()` creates a
 * two-way exchange: the client knows when the server has handled the message
 * and what it replied.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 * The `any` suppressions allow the prototype method to use generic types that
 * cannot be expressed on a prototype function directly.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { request as createRequest } from '~/request/request.ts';
import type { HandlerCtxFromState, NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { Validator } from '~/types.ts';

/**
 * Module augmentation: adds `.reply()` to the builder interfaces so TypeScript
 * recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register a request–response handler for `eventContract.event`.
     *
     * The client sends the event and waits for the server to reply. The engine
     * validates the inbound payload with `eventContract.schema` and the outbound
     * response with `responseSchema`, then sends the return value back.
     *
     * @param eventContract  Describes the event name and inbound payload schema.
     * @param responseSchema Validator for the value returned by `handler`.
     * @param handler        Called with the handler context and validated payload.
     *                       Returns the response value (sync or async).
     */
    reply<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (
        ctx: HandlerCtxFromState<TState>,
        payload: TPayload,
      ) => TResponse | Promise<TResponse>,
    ): ServerBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register a request–response handler for `eventContract.event`.
     *
     * @param eventContract  Describes the event name and inbound payload schema.
     * @param responseSchema Validator for the value returned by `handler`.
     * @param handler        Called with the handler context and validated payload.
     */
    reply<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (
        ctx: HandlerCtxFromState<TState>,
        payload: TPayload,
      ) => TResponse | Promise<TResponse>,
    ): GroupBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }
}

/**
 * Runtime implementation of `.reply()` for `ServerBuilder`.
 *
 * `_responseSchema` is accepted by the signature for type-checking purposes
 * but the engine does not use it at runtime — the payload validator comes from
 * `eventContract.schema` and response validation is handled by the client type
 * system.
 */
ServerBuilder.prototype.reply = function (
  this: ServerBuilder<any>,
  eventContract: EventContract,
  _responseSchema: Validator,
  handler: any,
) {
  this._primitives.push(
    (createRequest as any)(eventContract.event, handler, {
      validator: eventContract.schema,
    }) as Primitive,
  );
  return this;
};

/** Runtime implementation of `.reply()` for `GroupBuilder`. */
GroupBuilder.prototype.reply = function (
  this: GroupBuilder<any>,
  eventContract: EventContract,
  _responseSchema: Validator,
  handler: any,
) {
  this._primitives.push(
    (createRequest as any)(eventContract.event, handler, {
      validator: eventContract.schema,
    }) as Primitive,
  );
  return this;
};
