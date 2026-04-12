/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';

export interface UpgradeResult {
  readonly meta?: Record<string, unknown>;
  readonly tags?: readonly string[];
}

export type InitHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ConnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type DisconnectHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ShutdownHandler<TCtx = any> = (ctx: TCtx) => void | Promise<void>;
export type ErrorHandler<TCtx = any> = (ctx: TCtx, error: unknown, event?: string) => void | Promise<void>;
export type UpgradeHandler = (request: Request) => UpgradeResult | Promise<UpgradeResult>;
export type BinaryHandler<TCtx = any> = (ctx: TCtx, data: ArrayBuffer) => void | Promise<void>;
export type ValidationErrorHandler<TCtx = any> = (ctx: TCtx, event: string, validationError: unknown) => void | Promise<void>;

export interface InitPrimitive<TCtx = any> extends Primitive<'onInit'> { readonly handler: InitHandler<TCtx>; }
export interface ConnectPrimitive<TCtx = any> extends Primitive<'onConnect'> { readonly handler: ConnectHandler<TCtx>; }
export interface DisconnectPrimitive<TCtx = any> extends Primitive<'onDisconnect'> { readonly handler: DisconnectHandler<TCtx>; }
export interface ShutdownPrimitive<TCtx = any> extends Primitive<'onShutdown'> { readonly handler: ShutdownHandler<TCtx>; }
export interface ErrorPrimitive<TCtx = any> extends Primitive<'onError'> { readonly handler: ErrorHandler<TCtx>; }
export interface UpgradePrimitive extends Primitive<'onUpgrade'> { readonly handler: UpgradeHandler; }
export interface BinaryPrimitive<TCtx = any> extends Primitive<'onBinary'> { readonly handler: BinaryHandler<TCtx>; }
export interface ValidationErrorPrimitive<TCtx = any> extends Primitive<'onValidationError'> { readonly handler: ValidationErrorHandler<TCtx>; }

const ON_INIT_KEY = Symbol('onInit');
const ON_CONNECT_KEY = Symbol('onConnect');
const ON_DISCONNECT_KEY = Symbol('onDisconnect');
const ON_SHUTDOWN_KEY = Symbol('onShutdown');
const ON_ERROR_KEY = Symbol('onError');
const ON_UPGRADE_KEY = Symbol('onUpgrade');
const ON_BINARY_KEY = Symbol('onBinary');
const ON_VALIDATION_ERROR_KEY = Symbol('onValidationError');

function makeLifecycle<TTag extends string>(
  tag: TTag,
  key: symbol,
  setupFn: (engine: EngineAccess, handler: any) => void,
) {
  return <THandler>(handler: THandler) => ({
    __wskit: tag,
    __kind: 'lifecycle' as const,
    __identity: [key] as const,
    __dependencies: [] as const,
    __requires: {},
    handler,
    __setup(engine: EngineAccess) {
      setupFn(engine, handler);
    },
  });
}

export const onInit = Object.assign(
  makeLifecycle('onInit', ON_INIT_KEY, (e, h) => e.onInit(h)) as <TCtx>(handler: InitHandler<TCtx>) => InitPrimitive<TCtx>,
  { __key: ON_INIT_KEY },
);
export const onConnect = Object.assign(
  makeLifecycle('onConnect', ON_CONNECT_KEY, (e, h) => e.onConnect(h)) as <TCtx>(handler: ConnectHandler<TCtx>) => ConnectPrimitive<TCtx>,
  { __key: ON_CONNECT_KEY },
);
export const onDisconnect = Object.assign(
  makeLifecycle('onDisconnect', ON_DISCONNECT_KEY, (e, h) => e.onDisconnect(h)) as <TCtx>(handler: DisconnectHandler<TCtx>) => DisconnectPrimitive<TCtx>,
  { __key: ON_DISCONNECT_KEY },
);
export const onShutdown = Object.assign(
  makeLifecycle('onShutdown', ON_SHUTDOWN_KEY, (e, h) => e.onShutdown(h)) as <TCtx>(handler: ShutdownHandler<TCtx>) => ShutdownPrimitive<TCtx>,
  { __key: ON_SHUTDOWN_KEY },
);
export const onError = Object.assign(
  makeLifecycle('onError', ON_ERROR_KEY, (e, h) => e.onError(h)) as <TCtx>(handler: ErrorHandler<TCtx>) => ErrorPrimitive<TCtx>,
  { __key: ON_ERROR_KEY },
);
export const onUpgrade = Object.assign(
  makeLifecycle('onUpgrade', ON_UPGRADE_KEY, (e, h) => e.onUpgrade(h)) as (handler: UpgradeHandler) => UpgradePrimitive,
  { __key: ON_UPGRADE_KEY },
);
export const onBinary = Object.assign(
  makeLifecycle('onBinary', ON_BINARY_KEY, (e, h) => e.onBinary(h)) as <TCtx>(handler: BinaryHandler<TCtx>) => BinaryPrimitive<TCtx>,
  { __key: ON_BINARY_KEY },
);
export const onValidationError = Object.assign(
  makeLifecycle('onValidationError', ON_VALIDATION_ERROR_KEY, (e, h) => e.onValidationError(h)) as <TCtx>(handler: ValidationErrorHandler<TCtx>) => ValidationErrorPrimitive<TCtx>,
  { __key: ON_VALIDATION_ERROR_KEY },
);

import '~/_builder/side-effects/lifecycle.ts';
