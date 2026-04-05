/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Primitive } from '~/primitives/define.ts';
import type { Validator } from '~/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The handler function for a request. Like `IncomingHandler` but returns
 * a value — the response sent back to the client.
 *
 * `ctx` is typed as `any` here — `defineServer` narrows it based on
 * which primitives are registered.
 */
export type RequestHandler<TPayload = unknown, TResponse = unknown> = (
  ctx: any,
  payload: TPayload,
) => TResponse | Promise<TResponse>;

/**
 * The primitive instance returned by `request()`. Carries the event name,
 * handler, and optional validator. `InferClientType` reads `TEvent`,
 * `TPayload`, and `TResponse` to produce the client's `requests` type.
 *
 * ```ts
 * request('get-history', async (ctx, payload) => {
 *   const rows = ctx.sql.exec('SELECT * FROM messages WHERE channel = ? LIMIT ?',
 *     ctx.channelName, payload.limit).toArray();
 *   return { messages: rows, hasMore: rows.length === payload.limit };
 * }, { validator: GetHistoryValidator })
 * ```
 */
export interface RequestPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TResponse = unknown,
> extends Primitive<'request'> {
  readonly event: TEvent;
  readonly handler: RequestHandler<TPayload, TResponse>;
  readonly validator?: Validator<TPayload>;
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

const REQUEST_KEY = Symbol('request');

const _request = definePrimitive({
  tag: 'request' as const,
  key: REQUEST_KEY,
  kind: 'handler' as const,
  registrationId(event: string, _handler: any, _options?: any) {
    return event;
  },
  create(event: string, handler: RequestHandler, options?: { validator?: Validator }) {
    return { event, handler, validator: options?.validator };
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a request from the client and return a response.
 *
 * Same shape as `incoming` but the return value is sent back to the client.
 * The client calls `socket.request(event, payload)` and gets a Promise
 * that resolves with the return value.
 *
 * Behind the scenes, the engine uses `_correlationId` to match the response
 * to the right client-side Promise.
 *
 * **Without validator:**
 * ```ts
 * request('get-presence', async (ctx) => {
 *   return { users: getOnlineUsers(ctx) };
 * })
 * ```
 *
 * **With validator:**
 * ```ts
 * request('get-history', async (ctx, payload) => {
 *   return { messages: getMessages(ctx, payload.limit) };
 * }, { validator: v.object({ limit: v.number() }) })
 * ```
 *
 * If the handler throws a defined error, the client's Promise rejects
 * with a typed `WskitError`. If it throws an unrecognized error, the
 * client gets `{ code: 'internal-error' }`.
 */
export function request<TEvent extends string, TResponse>(
  event: TEvent,
  handler: RequestHandler<unknown, TResponse>,
): RequestPrimitive<TEvent, unknown, TResponse>;
export function request<TEvent extends string, TPayload, TResponse>(
  event: TEvent,
  handler: RequestHandler<TPayload, TResponse>,
  options: { validator: (value: unknown) => TPayload },
): RequestPrimitive<TEvent, TPayload, TResponse>;
export function request<TEvent extends string, TSchema extends StandardSchemaV1, TResponse>(
  event: TEvent,
  handler: RequestHandler<StandardSchemaV1.InferOutput<TSchema>, TResponse>,
  options: { validator: TSchema },
): RequestPrimitive<TEvent, StandardSchemaV1.InferOutput<TSchema>, TResponse>;
export function request(
  event: string,
  handler: RequestHandler,
  options?: { validator?: Validator },
): RequestPrimitive {
  return _request(event, handler, options) as unknown as RequestPrimitive;
}

/** Dependency ref — use in `dependencies: [request]` to assert it's registered. */
request.__key = REQUEST_KEY;
