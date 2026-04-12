/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export type RequestHandler<TCtx = any, TPayload = unknown, TResponse = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => TResponse | Promise<TResponse>;

export interface RequestPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TResponse = unknown,
  TCtx = any,
> extends Primitive<'request'> {
  readonly event: TEvent;
  readonly handler: RequestHandler<TCtx, TPayload, TResponse>;
  readonly validator?: Validator<TPayload>;
}

const REQUEST_KEY = Symbol('request');

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

request.__key = REQUEST_KEY;
