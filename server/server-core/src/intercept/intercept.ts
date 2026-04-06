/* oxlint-disable @typescript-eslint/no-explicit-any */
import { unwrapHandled } from '~/h.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Handled } from '~/h.ts';
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

const _intercept = definePrimitive<
  'intercept',
  [firstArg: string | PreInterceptHandler, secondArg?: PostInterceptHandler],
  {
    mode: 'pre' | 'post';
    event?: string;
    handler: PreInterceptHandler | PostInterceptHandler;
  }
>({
  tag: 'intercept' as const,
  key: INTERCEPT_KEY,
  kind: 'infrastructure' as const,
  registrationId(firstArg: string | PreInterceptHandler) {
    return typeof firstArg === 'string' ? `post:${firstArg}` : 'pre';
  },
  create(firstArg: string | PreInterceptHandler, secondArg?: PostInterceptHandler) {
    if (typeof firstArg === 'string') {
      return {
        mode: 'post' as const,
        event: firstArg,
        handler: secondArg!,
      };
    }

    return {
      mode: 'pre' as const,
      handler: firstArg,
    };
  },
});

/**
 * Intercept messages before validation.
 *
 * Use this to inspect or rewrite raw incoming messages before wskit checks
 * their schema. At this stage, the payload is still `unknown`.
 *
 * Wrap the callback in `h(...)` when you want the scope-specific `ctx`
 * type to show up in the editor.
 */
export function intercept<TCtx>(
  handler: Handled<PreInterceptHandler<TCtx>>,
): PreInterceptPrimitive<TCtx>;
export function intercept(handler: PreInterceptHandler<any>): PreInterceptPrimitive<any>;

/**
 * Intercept one event after validation.
 *
 * Use this when you want to inspect or rewrite a typed payload after wskit
 * has already validated it.
 *
 * Wrap the callback in `h(...)` when you want the scope-specific `ctx`
 * type to show up in the editor.
 */
export function intercept<TCtx, TEvent extends string, TPayload>(
  event: TEvent,
  handler: Handled<PostInterceptHandler<TCtx, TPayload>>,
): PostInterceptPrimitive<TEvent, TPayload, TCtx>;
export function intercept<TEvent extends string>(
  event: TEvent,
  handler: PostInterceptHandler<any, any>,
): PostInterceptPrimitive<TEvent, any, any>;

export function intercept(
  firstArg: string | PreInterceptHandler<any> | Handled<PreInterceptHandler<any>>,
  secondArg?: PostInterceptHandler<any, any> | Handled<PostInterceptHandler<any, any>>,
): InterceptPrimitive {
  if (typeof firstArg === 'string') {
    return _intercept(firstArg, unwrapHandled(secondArg!)) as InterceptPrimitive;
  }

  return _intercept(unwrapHandled(firstArg)) as InterceptPrimitive;
}

/** Dependency ref — use in `dependencies: [intercept]` to assert it's registered. */
intercept.__key = INTERCEPT_KEY;
