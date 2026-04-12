/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export type SubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type UnsubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type BeforeSubscribeHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data?: TData,
) => void | Promise<void>;

export interface BeforeSubscribePrimitive<TCtx = any, TData = unknown> extends Primitive<'onBeforeSubscribe'> {
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
    __setup(engine: any) {
      engine.onBeforeSubscribe(handler, options?.validator);
    },
  };
}

export function onSubscribe<TCtx>(handler: SubscribeHandler<TCtx>): SubscribePrimitive<TCtx> {
  return {
    __wskit: 'onSubscribe',
    __kind: 'lifecycle',
    __identity: [ON_SUBSCRIBE_KEY],
    __dependencies: [],
    __requires: {},
    handler,
    __setup(engine: any) {
      engine.onSubscribe(handler);
    },
  };
}

export function onUnsubscribe<TCtx>(handler: UnsubscribeHandler<TCtx>): UnsubscribePrimitive<TCtx> {
  return {
    __wskit: 'onUnsubscribe',
    __kind: 'lifecycle',
    __identity: [ON_UNSUBSCRIBE_KEY],
    __dependencies: [],
    __requires: {},
    handler,
    __setup(engine: any) {
      engine.onUnsubscribe(handler);
    },
  };
}

onBeforeSubscribe.__key = ON_BEFORE_SUBSCRIBE_KEY;
onSubscribe.__key = ON_SUBSCRIBE_KEY;
onUnsubscribe.__key = ON_UNSUBSCRIBE_KEY;
