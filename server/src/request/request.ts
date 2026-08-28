/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidWSKitIdentifier } from '@wskit/core';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * The `respond` callback injected into the handler context for `.request()`
 * handlers. Sends the response back to the requesting client.
 */
export interface RespondMethod<TResponse = unknown> {
  respond(response: TResponse): void;
}

/**
 * Handler function for a request/response pair. Receives `ctx.respond(value)`
 * to send the reply.
 */
export type RequestHandler<TCtx = any, TPayload = unknown, TResponse = unknown> = (
  ctx: TCtx & RespondMethod<TResponse>,
  payload: TPayload,
) => void | Promise<void>;

/**
 * Primitive produced by `request()`. Carries the event name, handler, and
 * optional validator so the engine can dispatch, validate, call the handler,
 * and send back the response.
 */
export interface RequestPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TResponse = unknown,
  TCtx = any,
> extends Primitive<'request'> {
  /** The event name the client sends to initiate the request. */
  readonly event: TEvent;
  /** The function that handles the request and calls `ctx.respond()`. */
  readonly handler: RequestHandler<TCtx, TPayload, TResponse>;
  /** Whether this handler may start without waiting for prior app work. */
  readonly allowInterleaving: boolean;
  /**
   * Optional schema validator. When present, the engine validates the raw
   * payload before calling `handler`. If validation fails, `onValidationError`
   * fires instead.
   */
  readonly validator?: Validator<TPayload>;
  /**
   * Optional response schema recorded on the primitive for type inference and
   * future runtime introspection (e.g. a dashboard reading the
   * `ServerDefinition`). The engine does NOT validate `ctx.respond(value)` at
   * send time — outgoing validation is intentional overhead the framework
   * avoids; the type contract on the client side is the developer's
   * responsibility.
   */
  readonly responseSchema?: Validator<TResponse>;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const REQUEST_KEY = Symbol('request');

/**
 * Internal primitive factory. The user-facing `request()` for declaring a
 * request/response pair in a contract lives at `~/request/definition.ts`.
 * This factory is called by the implementer's compile step to bind a
 * registered handler to a `RequestDef`.
 */
export function request<TEvent extends string, TPayload, TResponse, TCtx = any>(
  event: TEvent,
  handler: RequestHandler<TCtx, TPayload, TResponse>,
  options?: {
    validator?: Validator<TPayload>;
    responseSchema?: Validator<TResponse>;
    allowInterleaving?: boolean;
  },
): RequestPrimitive<TEvent, TPayload, TResponse, TCtx> {
  assertValidWSKitIdentifier(event, 'request() event name');
  return {
    __wskit: 'request',
    __kind: 'handler',
    __identity: [REQUEST_KEY, event],
    __requires: {},
    event,
    handler,
    allowInterleaving: options?.allowInterleaving ?? true,
    validator: options?.validator,
    responseSchema: options?.responseSchema,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
request.__key = REQUEST_KEY;
