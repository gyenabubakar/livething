/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { Primitive } from '~/primitive.ts';

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
) => void | Promise<void>;
export type UpgradeHandler = (request: Request) => UpgradeResult | Promise<UpgradeResult>;
export type BinaryHandler<TCtx = any> = (ctx: TCtx, data: ArrayBuffer) => void | Promise<void>;
export type ValidationErrorHandler<TCtx = any> = (
  ctx: TCtx,
  event: string,
  validationError: unknown,
) => void | Promise<void>;

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
function defineLifecyclePrimitive<TTag extends string, THandler>(tag: TTag, key: symbol) {
  return definePrimitive<TTag, [handler: THandler], { handler: THandler }>({
    tag,
    key,
    kind: 'lifecycle' as const,
    create(handler: THandler) {
      return { handler };
    },
    setup(engine, data) {
      switch (tag) {
        case 'onInit':
          engine.onInit(data.handler as InitHandler<any>);
          break;
        case 'onConnect':
          engine.onConnect(data.handler as ConnectHandler<any>);
          break;
        case 'onDisconnect':
          engine.onDisconnect(data.handler as DisconnectHandler<any>);
          break;
        case 'onShutdown':
          engine.onShutdown(data.handler as ShutdownHandler<any>);
          break;
        case 'onError':
          engine.onError(data.handler as ErrorHandler<any>);
          break;
        case 'onUpgrade':
          engine.onUpgrade(data.handler as UpgradeHandler);
          break;
        case 'onBinary':
          engine.onBinary(data.handler as BinaryHandler<any>);
          break;
        case 'onValidationError':
          engine.onValidationError(data.handler as ValidationErrorHandler<any>);
          break;
      }
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
const _onInit = defineLifecyclePrimitive('onInit', ON_INIT_KEY);
const _onConnect = defineLifecyclePrimitive('onConnect', ON_CONNECT_KEY);
const _onDisconnect = defineLifecyclePrimitive('onDisconnect', ON_DISCONNECT_KEY);
const _onShutdown = defineLifecyclePrimitive('onShutdown', ON_SHUTDOWN_KEY);
const _onError = defineLifecyclePrimitive('onError', ON_ERROR_KEY);
const _onUpgrade = defineLifecyclePrimitive('onUpgrade', ON_UPGRADE_KEY);
const _onBinary = defineLifecyclePrimitive('onBinary', ON_BINARY_KEY);
const _onValidationError = defineLifecyclePrimitive('onValidationError', ON_VALIDATION_ERROR_KEY);

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
onInit.__key = ON_INIT_KEY;
onConnect.__key = ON_CONNECT_KEY;
onDisconnect.__key = ON_DISCONNECT_KEY;
onShutdown.__key = ON_SHUTDOWN_KEY;
onError.__key = ON_ERROR_KEY;
onUpgrade.__key = ON_UPGRADE_KEY;
onBinary.__key = ON_BINARY_KEY;
onValidationError.__key = ON_VALIDATION_ERROR_KEY;
