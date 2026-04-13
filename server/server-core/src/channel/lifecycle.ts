/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

/**
 * Handler called after a client subscribes to a channel. Receives only the
 * handler context — the subscription is already confirmed at this point.
 */
export type SubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler called when a client unsubscribes from a channel, or when the
 * connection drops while the client is still subscribed.
 */
export type UnsubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

/**
 * Handler called before a client's subscription is confirmed. Throw to reject
 * the subscription. Optionally receives `data` — the payload the client sent
 * with the subscription request (e.g. an auth token).
 */
export type BeforeSubscribeHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data?: TData,
) => void | Promise<void>;

/** Primitive type produced by `onBeforeSubscribe()`. */
export interface BeforeSubscribePrimitive<
  TCtx = any,
  TData = unknown,
> extends Primitive<'onBeforeSubscribe'> {
  readonly handler: BeforeSubscribeHandler<TCtx, TData>;
  /**
   * Optional schema validator for the subscription data payload. When present,
   * the engine validates `data` before calling `handler`.
   */
  readonly validator?: Validator<TData>;
}

/** Primitive type produced by `onSubscribe()`. */
export interface SubscribePrimitive<TCtx = any> extends Primitive<'onSubscribe'> {
  readonly handler: SubscribeHandler<TCtx>;
}

/** Primitive type produced by `onUnsubscribe()`. */
export interface UnsubscribePrimitive<TCtx = any> extends Primitive<'onUnsubscribe'> {
  readonly handler: UnsubscribeHandler<TCtx>;
}

const ON_BEFORE_SUBSCRIBE_KEY = Symbol('onBeforeSubscribe');
const ON_SUBSCRIBE_KEY = Symbol('onSubscribe');
const ON_UNSUBSCRIBE_KEY = Symbol('onUnsubscribe');

/**
 * Creates an `onBeforeSubscribe` lifecycle primitive for a channel. The handler
 * runs before the client's subscription is confirmed. Throw from the handler
 * (e.g. `throw Forbidden()`) to reject the subscription.
 *
 * Optionally pass `options.validator` to validate the subscription data payload
 * the client may send alongside the subscribe request.
 *
 * @example
 * ```ts
 * server('chat')
 *   .channel('private-room', (ch) =>
 *     ch.onBeforeSubscribe(async (ctx, data) => {
 *       if (!ctx.meta.roles.includes('member')) throw Forbidden();
 *     }),
 *   )
 *   .build();
 * ```
 */
export function onBeforeSubscribe<TCtx, TData = unknown>(
  handler: BeforeSubscribeHandler<TCtx, TData>,
  options?: { validator?: Validator<TData> },
): BeforeSubscribePrimitive<TCtx, TData> {
  return {
    __wskit: 'onBeforeSubscribe',
    __kind: 'lifecycle',
    __identity: [ON_BEFORE_SUBSCRIBE_KEY],
    __dependencies: [],
    __requires: {},
    handler,
    validator: options?.validator,
    __setup(engine: EngineAccess) {
      engine.onBeforeSubscribe(handler as BeforeSubscribeHandler, options?.validator);
    },
  };
}

/**
 * Creates an `onSubscribe` lifecycle primitive for a channel. The handler runs
 * after the subscription is confirmed. Use this to send initial state to the
 * newly subscribed client.
 *
 * @example
 * ```ts
 * server('chat')
 *   .channel('notifications', (ch) =>
 *     ch.onSubscribe(async (ctx) => {
 *       const items = await db.getUnread(ctx.meta.userId);
 *       ctx.send.notifications(items);
 *     }),
 *   )
 *   .build();
 * ```
 */
export function onSubscribe<TCtx>(handler: SubscribeHandler<TCtx>): SubscribePrimitive<TCtx> {
  return {
    __wskit: 'onSubscribe',
    __kind: 'lifecycle',
    __identity: [ON_SUBSCRIBE_KEY],
    __dependencies: [],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onSubscribe(handler as SubscribeHandler);
    },
  };
}

/**
 * Creates an `onUnsubscribe` lifecycle primitive for a channel. The handler
 * runs when a client unsubscribes or disconnects while subscribed. Use this
 * for cleanup, presence tracking, or releasing locks.
 */
export function onUnsubscribe<TCtx>(handler: UnsubscribeHandler<TCtx>): UnsubscribePrimitive<TCtx> {
  return {
    __wskit: 'onUnsubscribe',
    __kind: 'lifecycle',
    __identity: [ON_UNSUBSCRIBE_KEY],
    __dependencies: [],
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      engine.onUnsubscribe(handler as UnsubscribeHandler);
    },
  };
}

/** Symbol key used to reference `onBeforeSubscribe` in dependency declarations. */
onBeforeSubscribe.__key = ON_BEFORE_SUBSCRIBE_KEY;
/** Symbol key used to reference `onSubscribe` in dependency declarations. */
onSubscribe.__key = ON_SUBSCRIBE_KEY;
/** Symbol key used to reference `onUnsubscribe` in dependency declarations. */
onUnsubscribe.__key = ON_UNSUBSCRIBE_KEY;
