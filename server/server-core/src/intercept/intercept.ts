/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

export interface InterceptMessage {
  readonly event: string;
  readonly payload: unknown;
}

export type PreInterceptResult = InterceptMessage | void | Promise<InterceptMessage | void>;
export type PostInterceptResult<TPayload> = TPayload | void | Promise<TPayload | void>;

export type PreInterceptHandler<TCtx = any> = (
  ctx: TCtx,
  message: InterceptMessage,
) => PreInterceptResult;

export type PostInterceptHandler<TCtx = any, TPayload = unknown> = (
  ctx: TCtx,
  payload: TPayload,
) => PostInterceptResult<TPayload>;

export interface PreInterceptPrimitive<TCtx = any> extends Primitive<'intercept'> {
  readonly mode: 'pre';
  readonly handler: PreInterceptHandler<TCtx>;
}

export interface PostInterceptPrimitive<
  TEvent extends string = string,
  TPayload = unknown,
  TCtx = any,
> extends Primitive<'intercept'> {
  readonly mode: 'post';
  readonly event: TEvent;
  readonly handler: PostInterceptHandler<TCtx, TPayload>;
}

export type InterceptPrimitive<TEvent extends string = string, TPayload = unknown, TCtx = any> =
  | PreInterceptPrimitive<TCtx>
  | PostInterceptPrimitive<TEvent, TPayload, TCtx>;

const INTERCEPT_KEY = Symbol('intercept');

export function intercept(handler: PreInterceptHandler<any>): PreInterceptPrimitive<any>;
export function intercept<TEvent extends string>(
  event: TEvent,
  handler: PostInterceptHandler<any, any>,
): PostInterceptPrimitive<TEvent, any, any>;
export function intercept(
  firstArg: string | PreInterceptHandler<any>,
  secondArg?: PostInterceptHandler<any, any>,
): InterceptPrimitive {
  if (typeof firstArg === 'string') {
    return {
      __wskit: 'intercept',
      __kind: 'infrastructure',
      __identity: [INTERCEPT_KEY, `post:${firstArg}`],
      __dependencies: [],
      __requires: {},
      mode: 'post',
      event: firstArg,
      handler: secondArg!,
    };
  }

  return {
    __wskit: 'intercept',
    __kind: 'infrastructure',
    __identity: [INTERCEPT_KEY, 'pre'],
    __dependencies: [],
    __requires: {},
    mode: 'pre',
    handler: firstArg,
  };
}

intercept.__key = INTERCEPT_KEY;
