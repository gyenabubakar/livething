/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * The function signature for a request–response handler.
 *
 * Unlike an `IncomingHandler` (which returns `void`), a `RequestHandler` must
 * return the response value. The engine sends this value back to the client as
 * the reply.
 *
 * @param ctx      The handler context for the current connection.
 * @param payload  The validated inbound payload.
 * @returns        The response sent back to the client (sync or async).
 */
export type RequestHandler<TCtx = any, TPayload = unknown, TResponse = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => TResponse | Promise<TResponse>;

/**
 * The primitive type produced by `request()`. Carries the event name, handler,
 * and optional validator so the engine can dispatch, validate, call the handler,
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
  /** The function that returns the response value. */
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
 * when the client sends an event whose name matches `event`, waits for the
 * returned value, and sends it back to the client as the reply.
 *
 * In practice you rarely call `request()` directly. Use it through the builder
 * via `.reply(eventContract, responseSchema, handler)` — that method calls this
 * factory internally.
 *
 * @param event   The event name to respond to.
 * @param handler The function that computes and returns the response.
 * @param options.validator Optional schema validator for the inbound payload.
 *
 * @example
 * ```ts
 * const GetUser = event('get-user', z.object({ id: z.string() }));
 * const UserResponse = z.object({ name: z.string() });
 *
 * server('chat').reply(GetUser, UserResponse, async (ctx, payload) => {
 *   return await db.findUser(payload.id);
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
