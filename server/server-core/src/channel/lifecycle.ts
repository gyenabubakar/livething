/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export type SubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type UnsubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type BeforeSubscribeHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data?: TData,
) => void | Promise<void>;

export interface BeforeSubscribePrimitive<
  TCtx = any,
  TData = unknown,
> extends Primitive<'onBeforeSubscribe'> {
  readonly handler: BeforeSubscribeHandler<TCtx, TData>;
  readonly validator?: Validator<TData>;
}

export interface SubscribePrimitive<TCtx = any> extends Primitive<'onSubscribe'> {
  readonly handler: SubscribeHandler<TCtx>;
}

export interface UnsubscribePrimitive<TCtx = any> extends Primitive<'onUnsubscribe'> {
  readonly handler: UnsubscribeHandler<TCtx>;
}

const ON_BEFORE_SUBSCRIBE_KEY = Symbol('onBeforeSubscribe');
const ON_SUBSCRIBE_KEY = Symbol('onSubscribe');
const ON_UNSUBSCRIBE_KEY = Symbol('onUnsubscribe');

function defineChannelLifecyclePrimitive<TTag extends string, THandler>(tag: TTag, key: symbol) {
  return definePrimitive<TTag, [handler: THandler], { handler: THandler }>({
    tag,
    key,
    kind: 'lifecycle' as const,
    create(handler: THandler) {
      return { handler };
    },
    setup(engine, data) {
      switch (tag) {
        case 'onSubscribe':
          engine.onSubscribe(data.handler as SubscribeHandler<any>);
          break;
        case 'onUnsubscribe':
          engine.onUnsubscribe(data.handler as UnsubscribeHandler<any>);
          break;
      }
    },
  });
}

const _onSubscribe = defineChannelLifecyclePrimitive('onSubscribe', ON_SUBSCRIBE_KEY);
const _onUnsubscribe = defineChannelLifecyclePrimitive('onUnsubscribe', ON_UNSUBSCRIBE_KEY);

const _onBeforeSubscribe = definePrimitive<
  'onBeforeSubscribe',
  [handler: BeforeSubscribeHandler<any, any>, options?: { validator?: Validator<any> }],
  { handler: BeforeSubscribeHandler<any, any>; validator?: Validator<any> }
>({
  tag: 'onBeforeSubscribe' as const,
  key: ON_BEFORE_SUBSCRIBE_KEY,
  kind: 'lifecycle' as const,
  create(handler: BeforeSubscribeHandler<any, any>, options?: { validator?: Validator<any> }) {
    return {
      handler,
      validator: options?.validator,
    };
  },
  setup(engine, data) {
    engine.onBeforeSubscribe(data.handler, data.validator);
  },
});

/**
 * Run before a channel subscription is accepted.
 *
 * Throw to reject. Optionally validate the subscription payload with a
 * validator in the `options` object.
 *
 * ```ts
 * onBeforeSubscribe(async (ctx, data) => {
 *   const hasAccess = await checkPermission(ctx.meta.userId, ctx.channel.name);
 *   if (!hasAccess) throw Forbidden({ reason: 'No access to this channel' });
 * }, { validator: SubscribePayloadValidator })
 * ```
 */
export function onBeforeSubscribe<TCtx, TData = unknown>(
  handler: BeforeSubscribeHandler<TCtx, TData>,
  options?: { validator?: Validator<TData> },
): BeforeSubscribePrimitive<TCtx, TData> {
  return _onBeforeSubscribe(handler, options) as BeforeSubscribePrimitive<TCtx, TData>;
}

/**
 * Run after a connection successfully subscribes to a channel.
 *
 * ```ts
 * onSubscribe(async (ctx) => {
 *   ctx.log.info('Joined channel', { channel: ctx.channel.name });
 * })
 * ```
 */
export function onSubscribe<TCtx>(handler: SubscribeHandler<TCtx>): SubscribePrimitive<TCtx> {
  return _onSubscribe(handler) as SubscribePrimitive<TCtx>;
}

/**
 * Run after a connection unsubscribes from a channel.
 *
 * ```ts
 * onUnsubscribe(async (ctx) => {
 *   ctx.log.info('Left channel', { channel: ctx.channel.name });
 * })
 * ```
 */
export function onUnsubscribe<TCtx>(handler: UnsubscribeHandler<TCtx>): UnsubscribePrimitive<TCtx> {
  return _onUnsubscribe(handler) as UnsubscribePrimitive<TCtx>;
}

onBeforeSubscribe.__key = ON_BEFORE_SUBSCRIBE_KEY;
onSubscribe.__key = ON_SUBSCRIBE_KEY;
onUnsubscribe.__key = ON_UNSUBSCRIBE_KEY;
