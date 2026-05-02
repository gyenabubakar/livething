/* oxlint-disable @typescript-eslint/no-explicit-any */
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
 * The function signature for a request–response handler.
 *
 * Unlike an `IncomingHandler` (which is fire-and-forget), a `RequestHandler`
 * receives `ctx.respond()` to explicitly send the response back to the client.
 * This keeps the sending model consistent across the library — all data going
 * to the client goes through an explicit send call.
 *
 * @param ctx      The handler context with `respond()` for sending the reply.
 * @param payload  The validated inbound payload.
 */
export type RequestHandler<TCtx = any, TPayload = unknown, TResponse = unknown> = (
  ctx: TCtx & RespondMethod<TResponse>,
  payload: TPayload,
) => void | Promise<void>;

/**
 * The primitive type produced by `request()`. Carries the event name, handler,
 * and optional validator so the engine can dispatch, validate, call the handler,
 * and send back the response via `ctx.respond()`.
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
 * Creates a request–response handler primitive. The engine calls `handler`
 * when the client sends an event whose name matches `event`. The handler
 * uses `ctx.respond(value)` to send the response back to the client.
 *
 * In practice you rarely call `request()` directly. Use it through the builder
 * via `.request(eventContract, responseSchema, handler)`. The response schema
 * is recorded on the primitive for type inference and future introspection,
 * not enforced at runtime.
 *
 * @param event   The event name to respond to.
 * @param handler The function that handles the request.
 * @param options.validator Optional schema validator for the inbound payload.
 * @param options.responseSchema Optional response schema kept on the
 *   primitive for type inference and runtime introspection. Not enforced.
 *
 * @example
 * ```ts
 * import { server, event } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const GetUser = event('get-user', v.object({ id: v.string() }));
 * const UserResponse = v.object({ name: v.string() });
 *
 * server('chat').request(GetUser, UserResponse, async (ctx, payload) => {
 *   const user = await db.findUser(payload.id);
 *   ctx.respond(user);
 * });
 * ```
 */
export function request<TEvent extends string, TPayload, TResponse, TCtx = any>(
  event: TEvent,
  handler: RequestHandler<TCtx, TPayload, TResponse>,
  options?: { validator?: Validator<TPayload>; responseSchema?: Validator<TResponse> },
): RequestPrimitive<TEvent, TPayload, TResponse, TCtx> {
  return {
    __wskit: 'request',
    __kind: 'handler',
    __identity: [REQUEST_KEY, event],
    __dependencies: [],
    __requires: {},
    event,
    handler,
    validator: options?.validator,
    responseSchema: options?.responseSchema,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
request.__key = REQUEST_KEY;
