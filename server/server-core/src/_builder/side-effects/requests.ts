/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Side-effect import that adds `.request()` to the server and group builders.
 *
 * Import path: `import '@wskit/server/requests'`
 * Adds method: `.request(eventContract, responseSchema, handler)`
 *
 * Calling `.request()` registers a request–response handler. The client sends
 * an event and awaits a response. The handler receives `ctx.respond()` to
 * explicitly send the response back — consistent with how all other sends
 * work in the library.
 *
 * Unlike `.incoming()`, which is fire-and-forget, `.request()` creates a
 * two-way exchange: the client knows when the server has handled the message
 * and what it replied.
 *
 * This file uses module augmentation (`declare module`) to teach TypeScript
 * about the new method and prototype patching to add the runtime implementation.
 */

import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import { request as createRequest } from '~/request/request.ts';
import type { HandlerCtxFromState, NextState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { EventContract } from '~/event.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestPrimitive, RespondMethod } from '~/request/request.ts';
import type { Validator } from '~/types.ts';
import { NamespaceBuilder } from './namespaces.ts';

/**
 * Module augmentation: adds `.request()` to the builder interfaces so
 * TypeScript recognises the method after this file is imported.
 */
declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    /**
     * Register a request–response handler for `eventContract.event`.
     *
     * The client sends the event and waits for the server to respond. The
     * handler receives `ctx.respond()` to send the response back explicitly.
     *
     * @param eventContract  Describes the event name and inbound payload schema.
     * @param responseSchema Validator for the response value.
     * @param handler        Called with ctx (including `respond()`) and payload.
     */
    request<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (
        ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
        payload: TPayload,
      ) => void | Promise<void>,
    ): ServerBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    /**
     * Register a request–response handler for `eventContract.event`.
     *
     * @param eventContract  Describes the event name and inbound payload schema.
     * @param responseSchema Validator for the response value.
     * @param handler        Called with ctx (including `respond()`) and payload.
     */
    request<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (
        ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
        payload: TPayload,
      ) => void | Promise<void>,
    ): GroupBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>>;
  }
}

/**
 * Runtime implementation of `.request()` for `ServerBuilder`.
 */
ServerBuilder.prototype.request = function (
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

/** Runtime implementation of `.request()` for `GroupBuilder`. */
GroupBuilder.prototype.request = function (
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

/**
 * Module augmentation: adds `.request()` to `NamespaceBuilder` so namespaces
 * can register request–response handlers.
 */
declare module './namespaces.ts' {
  interface NamespaceBuilder<TParentState, TState extends ScopeStateShape, TName> {
    request<TEvent extends string, TPayload, TResponse>(
      eventContract: EventContract<TEvent, TPayload>,
      responseSchema: Validator<TResponse>,
      handler: (
        ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
        payload: TPayload,
      ) => void | Promise<void>,
    ): NamespaceBuilder<
      TParentState,
      NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>,
      TName
    >;
  }
}

/** Runtime implementation of `.request()` for `NamespaceBuilder`. */
NamespaceBuilder.prototype.request = function (
  this: NamespaceBuilder<any, any, any>,
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

/** @internal Side-effect registration marker. */
export const __sideEffect_requests = true;
