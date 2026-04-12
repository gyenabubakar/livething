/* oxlint-disable @typescript-eslint/no-explicit-any */
/* oxlint-disable eslint-plugin-import(no-cycle) */
import { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import {
  onBinary as createOnBinary,
  onConnect as createOnConnect,
  onDisconnect as createOnDisconnect,
  onError as createOnError,
  onInit as createOnInit,
  onShutdown as createOnShutdown,
  onUpgrade as createOnUpgrade,
  onValidationError as createOnValidationError,
} from '~/lifecycle.ts';
import type { HandlerCtxFromState, ScopeStateShape } from '~/_types/scope-state.ts';
import type { InitContext, ShutdownContext } from '~/context.ts';
import type { UpgradeResult } from '~/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';

declare module '~/_builder/server-builder.ts' {
  interface ServerBuilder<TState extends ScopeStateShape> {
    onInit(handler: (ctx: InitContext) => void | Promise<void>): ServerBuilder<TState>;
    onConnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): ServerBuilder<TState>;
    onDisconnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): ServerBuilder<TState>;
    onShutdown(handler: (ctx: ShutdownContext) => void | Promise<void>): ServerBuilder<TState>;
    onError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        error: unknown,
        event?: string,
      ) => void | Promise<void>,
    ): ServerBuilder<TState>;
    onUpgrade(
      handler: (request: Request) => UpgradeResult | Promise<UpgradeResult>,
    ): ServerBuilder<TState>;
    onBinary(
      handler: (ctx: HandlerCtxFromState<TState>, data: ArrayBuffer) => void | Promise<void>,
    ): ServerBuilder<TState>;
    onValidationError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        event: string,
        validationError: unknown,
      ) => void | Promise<void>,
    ): ServerBuilder<TState>;
  }

  interface GroupBuilder<TState extends ScopeStateShape> {
    onInit(handler: (ctx: InitContext) => void | Promise<void>): GroupBuilder<TState>;
    onConnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): GroupBuilder<TState>;
    onDisconnect(
      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
    ): GroupBuilder<TState>;
    onShutdown(handler: (ctx: ShutdownContext) => void | Promise<void>): GroupBuilder<TState>;
    onError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        error: unknown,
        event?: string,
      ) => void | Promise<void>,
    ): GroupBuilder<TState>;
    onUpgrade(
      handler: (request: Request) => UpgradeResult | Promise<UpgradeResult>,
    ): GroupBuilder<TState>;
    onBinary(
      handler: (ctx: HandlerCtxFromState<TState>, data: ArrayBuffer) => void | Promise<void>,
    ): GroupBuilder<TState>;
    onValidationError(
      handler: (
        ctx: HandlerCtxFromState<TState>,
        event: string,
        validationError: unknown,
      ) => void | Promise<void>,
    ): GroupBuilder<TState>;
  }
}

function patchLifecycle(proto: Record<string, any>, name: string, factory: (handler: any) => any) {
  proto[name] = function (this: { _primitives: Primitive[] }, handler: any) {
    this._primitives.push(factory(handler) as unknown as Primitive);
    return this;
  };
}

patchLifecycle(ServerBuilder.prototype, 'onInit', createOnInit);
patchLifecycle(ServerBuilder.prototype, 'onConnect', createOnConnect);
patchLifecycle(ServerBuilder.prototype, 'onDisconnect', createOnDisconnect);
patchLifecycle(ServerBuilder.prototype, 'onShutdown', createOnShutdown);
patchLifecycle(ServerBuilder.prototype, 'onError', createOnError);
patchLifecycle(ServerBuilder.prototype, 'onUpgrade', createOnUpgrade);
patchLifecycle(ServerBuilder.prototype, 'onBinary', createOnBinary);
patchLifecycle(ServerBuilder.prototype, 'onValidationError', createOnValidationError);

patchLifecycle(GroupBuilder.prototype, 'onInit', createOnInit);
patchLifecycle(GroupBuilder.prototype, 'onConnect', createOnConnect);
patchLifecycle(GroupBuilder.prototype, 'onDisconnect', createOnDisconnect);
patchLifecycle(GroupBuilder.prototype, 'onShutdown', createOnShutdown);
patchLifecycle(GroupBuilder.prototype, 'onError', createOnError);
patchLifecycle(GroupBuilder.prototype, 'onUpgrade', createOnUpgrade);
patchLifecycle(GroupBuilder.prototype, 'onBinary', createOnBinary);
patchLifecycle(GroupBuilder.prototype, 'onValidationError', createOnValidationError);
