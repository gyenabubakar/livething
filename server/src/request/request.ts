/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidLiveThingIdentifier } from '@livething/core';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

interface RequestOptions<TPayload> {
  validator?: Validator<TPayload>;
  allowInterleaving?: boolean;
}

/**
 * The `respond` callback injected into the handler context for `.request()`
 * handlers. Sends the response back to the requesting client.
 */
interface RespondMethod<TResponse = unknown> {
  respond(response: TResponse): void;
}

/**
 * Handler function for a request/response pair. Receives `ctx.respond(value)`
 * to send the reply. The builder creates this primitive while assembling a
 * selected `base.request(...)` value.
 */
export type RequestHandler<TCtx = any, TPayload = unknown, TResponse = unknown> = (
  ctx: TCtx & RespondMethod<TResponse>,
  payload: TPayload,
  bytes?: Uint8Array,
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
   * payload before calling `handler`. If validation fails, `onError` gets a
   * `ValidationFailed` error instead.
   */
  readonly validator?: Validator<TPayload>;
  /** `true` for a `base.binary.request(...)` handler, which takes only binary frames. */
  readonly binary?: boolean;
  /** The most bytes a binary request frame may carry. */
  readonly maxBytes?: number;
}

/** Unique symbol. The registration ID is the event name, so each event is its own singleton. */
const REQUEST_KEY = Symbol('request');

/**
 * Internal primitive factory. The user-facing builder is `base.request(...)`.
 * The definition compiler calls this while assembling a selected handler value.
 */
export function request<TEvent extends string, TPayload, TResponse, TCtx = any>(
  event: TEvent,
  handler: RequestHandler<TCtx, TPayload, TResponse>,
  options?: RequestOptions<TPayload>,
): RequestPrimitive<TEvent, TPayload, TResponse, TCtx> {
  assertValidLiveThingIdentifier(event, 'request() event name');
  if (typeof handler !== 'function') {
    throw new Error(`[livething] request('${event}'): 'run' must be a function.`);
  }

  return {
    __livething: 'request',
    __identity: [REQUEST_KEY, event],
    __requires: {},
    event,
    handler,
    allowInterleaving: options?.allowInterleaving ?? true,
    validator: options?.validator,
  };
}
