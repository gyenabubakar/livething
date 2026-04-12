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
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const REQUEST_KEY = Symbol('request');

/**
 * Creates a request–response handler primitive. The engine calls `handler`
 * when the client sends an event whose name matches `event`. The handler
 * uses `ctx.respond(value)` to send the response back to the client.
 *
 * In practice you rarely call `request()` directly. Use it through the builder
 * via `.request(eventContract, responseSchema, handler)`.
 *
 * @param event   The event name to respond to.
 * @param handler The function that handles the request.
 * @param options.validator Optional schema validator for the inbound payload.
 *
 * @example
 * ```ts
 * const GetUser = event('get-user', z.object({ id: z.string() }));
 * const UserResponse = z.object({ name: z.string() });
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
  options?: { validator?: Validator<TPayload> },
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
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
request.__key = REQUEST_KEY;
