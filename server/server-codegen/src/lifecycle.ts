/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';
import type { Validator } from '~/types.ts';

export interface UpgradeResult {
  readonly meta?: Record<string, unknown>;
  readonly tags?: readonly string[];
}

export type InitHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ConnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type DisconnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ShutdownHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ErrorHandler<TCtx = any> = (
  ctx: TCtx,
  error: unknown,
  event?: string,
) => boolean | void | Promise<boolean | void>;
export type UpgradeHandler = (request: Request) => UpgradeResult | Promise<UpgradeResult>;
export type BinaryHandler<TCtx = any> = (ctx: TCtx, data: ArrayBuffer) => void | Promise<void>;
export type ValidationErrorHandler<TCtx = any> = (
  ctx: TCtx,
  event: string,
  validationError: unknown,
) => void | Promise<void>;
export type BeforeSubscribeHandler<TCtx = any, TData = unknown> = (
  ctx: TCtx,
  data?: TData,
) => void | Promise<void>;
export type SubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type UnsubscribeHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;

export interface InitPrimitive<TCtx = any> extends Primitive<'onInit'> {
  readonly handler: InitHandler<TCtx>;
}
export interface ConnectPrimitive<TCtx = any> extends Primitive<'onConnect'> {
  readonly handler: ConnectHandler<TCtx>;
}
export interface DisconnectPrimitive<TCtx = any> extends Primitive<'onDisconnect'> {
  readonly handler: DisconnectHandler<TCtx>;
}
export interface ShutdownPrimitive<TCtx = any> extends Primitive<'onShutdown'> {
  readonly handler: ShutdownHandler<TCtx>;
}
export interface ErrorPrimitive<TCtx = any> extends Primitive<'onError'> {
  readonly handler: ErrorHandler<TCtx>;
}
export interface UpgradePrimitive extends Primitive<'onUpgrade'> {
  readonly handler: UpgradeHandler;
}
export interface BinaryPrimitive<TCtx = any> extends Primitive<'onBinary'> {
  readonly handler: BinaryHandler<TCtx>;
}
export interface ValidationErrorPrimitive<TCtx = any> extends Primitive<'onValidationError'> {
  readonly handler: ValidationErrorHandler<TCtx>;
}
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

function defineLifecyclePrimitive<TTag extends string, THandler>(tag: TTag, key: symbol) {
  return definePrimitive<TTag, [handler: THandler], { handler: THandler }>({
    tag,
    key,
    kind: 'lifecycle' as const,
    create(handler: THandler) {
      return { handler };
    },
  });
}

const ON_INIT_KEY = Symbol('onInit');
const ON_CONNECT_KEY = Symbol('onConnect');
const ON_DISCONNECT_KEY = Symbol('onDisconnect');
const ON_SHUTDOWN_KEY = Symbol('onShutdown');
const ON_ERROR_KEY = Symbol('onError');
const ON_UPGRADE_KEY = Symbol('onUpgrade');
const ON_BINARY_KEY = Symbol('onBinary');
const ON_VALIDATION_ERROR_KEY = Symbol('onValidationError');
const ON_BEFORE_SUBSCRIBE_KEY = Symbol('onBeforeSubscribe');
const ON_SUBSCRIBE_KEY = Symbol('onSubscribe');
const ON_UNSUBSCRIBE_KEY = Symbol('onUnsubscribe');

const _onInit = defineLifecyclePrimitive('onInit', ON_INIT_KEY);
const _onConnect = defineLifecyclePrimitive('onConnect', ON_CONNECT_KEY);
const _onDisconnect = defineLifecyclePrimitive('onDisconnect', ON_DISCONNECT_KEY);
const _onShutdown = defineLifecyclePrimitive('onShutdown', ON_SHUTDOWN_KEY);
const _onError = defineLifecyclePrimitive('onError', ON_ERROR_KEY);
const _onUpgrade = defineLifecyclePrimitive('onUpgrade', ON_UPGRADE_KEY);
const _onBinary = defineLifecyclePrimitive('onBinary', ON_BINARY_KEY);
const _onValidationError = defineLifecyclePrimitive('onValidationError', ON_VALIDATION_ERROR_KEY);
const _onSubscribe = defineLifecyclePrimitive('onSubscribe', ON_SUBSCRIBE_KEY);
const _onUnsubscribe = defineLifecyclePrimitive('onUnsubscribe', ON_UNSUBSCRIBE_KEY);

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
});

export function onInit<TCtx>(handler: InitHandler<TCtx>): InitPrimitive<TCtx> {
  return _onInit(handler) as InitPrimitive<TCtx>;
}
export function onConnect<TCtx>(handler: ConnectHandler<TCtx>): ConnectPrimitive<TCtx> {
  return _onConnect(handler) as ConnectPrimitive<TCtx>;
}
export function onDisconnect<TCtx>(handler: DisconnectHandler<TCtx>): DisconnectPrimitive<TCtx> {
  return _onDisconnect(handler) as DisconnectPrimitive<TCtx>;
}
export function onShutdown<TCtx>(handler: ShutdownHandler<TCtx>): ShutdownPrimitive<TCtx> {
  return _onShutdown(handler) as ShutdownPrimitive<TCtx>;
}
export function onError<TCtx>(handler: ErrorHandler<TCtx>): ErrorPrimitive<TCtx> {
  return _onError(handler) as ErrorPrimitive<TCtx>;
}
export function onUpgrade(handler: UpgradeHandler): UpgradePrimitive {
  return _onUpgrade(handler) as UpgradePrimitive;
}
export function onBinary<TCtx>(handler: BinaryHandler<TCtx>): BinaryPrimitive<TCtx> {
  return _onBinary(handler) as BinaryPrimitive<TCtx>;
}
export function onValidationError<TCtx>(
  handler: ValidationErrorHandler<TCtx>,
): ValidationErrorPrimitive<TCtx> {
  return _onValidationError(handler) as ValidationErrorPrimitive<TCtx>;
}
export function onBeforeSubscribe<TCtx, TData = unknown>(
  handler: BeforeSubscribeHandler<TCtx, TData>,
  options?: { validator?: Validator<TData> },
): BeforeSubscribePrimitive<TCtx, TData> {
  return _onBeforeSubscribe(handler, options) as BeforeSubscribePrimitive<TCtx, TData>;
}
export function onSubscribe<TCtx>(handler: SubscribeHandler<TCtx>): SubscribePrimitive<TCtx> {
  return _onSubscribe(handler) as SubscribePrimitive<TCtx>;
}
export function onUnsubscribe<TCtx>(handler: UnsubscribeHandler<TCtx>): UnsubscribePrimitive<TCtx> {
  return _onUnsubscribe(handler) as UnsubscribePrimitive<TCtx>;
}

onInit.__key = ON_INIT_KEY;
onConnect.__key = ON_CONNECT_KEY;
onDisconnect.__key = ON_DISCONNECT_KEY;
onShutdown.__key = ON_SHUTDOWN_KEY;
onError.__key = ON_ERROR_KEY;
onUpgrade.__key = ON_UPGRADE_KEY;
onBinary.__key = ON_BINARY_KEY;
onValidationError.__key = ON_VALIDATION_ERROR_KEY;
onBeforeSubscribe.__key = ON_BEFORE_SUBSCRIBE_KEY;
onSubscribe.__key = ON_SUBSCRIBE_KEY;
onUnsubscribe.__key = ON_UNSUBSCRIBE_KEY;
