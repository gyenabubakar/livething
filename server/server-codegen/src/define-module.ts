/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { ConnectionInfo } from '~/context.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/index.ts';
import type { OutgoingPrimitive } from '~/outgoing/index.ts';
import type { Primitive, PrimitiveRef, RequiresManifest } from '~/primitive.ts';
import type { ScheduledHandle, ScheduledOptions } from '~/scheduled/index.ts';

export interface ModuleHooks<TCtx = any> {
  onIncoming(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  onOutgoing(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  onInit(handler: (ctx: any) => void | Promise<void>): void;
  onConnect(handler: (ctx: TCtx) => void | Promise<void>): void;
  onDisconnect(handler: (ctx: TCtx) => void | Promise<void>): void;
  onShutdown(handler: () => void | Promise<void>): void;
  scheduled<TData>(
    name: string,
    handler: (ctx: any, data: TData) => void | Promise<void>,
    options?: ScheduledOptions<TData>,
  ): ScheduledHandle<TData>;
  generateId(prefix?: string): string;
  getState(): ConnectionInfo;
}

export type ModuleContextFactory<TCtx = any, TApi = unknown> = (ctx: TCtx) => TApi;

export interface ModuleConfig<
  TArgs,
  TApi,
  TCtx = any,
  TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> {
  readonly id: string;
  readonly key: symbol;
  readonly dependencies?: readonly PrimitiveRef[];
  readonly requires?: RequiresManifest;
  readonly outgoing?: TOutgoing;
  readonly errors?: ErrorsPrimitive<TErrors>;
  readonly setup: (args: TArgs, hooks: ModuleHooks<TCtx>) => ModuleContextFactory<TCtx, TApi>;
}

export interface ModuleInstance<
  TId extends string = string,
  TArgs = unknown,
  TApi = unknown,
  TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> extends Primitive<'module'> {
  readonly id: TId;
  readonly args: TArgs;
  readonly outgoing: TOutgoing;
  readonly errors?: ErrorsPrimitive<TErrors>;
  readonly setupModule: ModuleConfig<TArgs, TApi, any, TOutgoing, TErrors>['setup'];
}

export interface ModuleFactory<
  TId extends string = string,
  TArgs = unknown,
  TApi = unknown,
  TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> extends PrimitiveRef {
  (args: TArgs): ModuleInstance<TId, TArgs, TApi, TOutgoing, TErrors>;
  use<TCtx>(ctx: TCtx): TApi;
  readonly id: TId;
}

export const MODULE_API_MAP = Symbol.for('wskit.moduleApis');

function isModuleId(value: string): boolean {
  return /^[a-z0-9-]+:[a-z0-9-]+$/.test(value);
}

/**
 * Define a reusable third-party module.
 */
export function defineModule<
  TArgs,
  TApi,
  TCtx = any,
  const TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  const TErrors extends readonly ErrorDef<string, any>[] = readonly [],
>(
  config: ModuleConfig<TArgs, TApi, TCtx, TOutgoing, TErrors>,
): ModuleFactory<string, TArgs, TApi, TOutgoing, TErrors> {
  if (!isModuleId(config.id)) {
    throw new Error(
      `[wskit] Module id "${config.id}" is invalid. Use "author:name" lowercase format.`,
    );
  }

  const factory = definePrimitive<
    'module',
    [args: TArgs],
    {
      id: string;
      args: TArgs;
      outgoing: TOutgoing;
      errors?: ErrorsPrimitive<TErrors>;
      setupModule: ModuleConfig<TArgs, TApi, TCtx, TOutgoing, TErrors>['setup'];
    }
  >({
    tag: 'module' as const,
    key: config.key,
    kind: 'module' as const,
    dependencies: config.dependencies,
    requires: config.requires,
    create(args: TArgs) {
      return {
        id: config.id,
        args,
        outgoing: (config.outgoing ?? []) as TOutgoing,
        errors: config.errors,
        setupModule: config.setup,
      };
    },
  });

  return Object.assign(
    ((args: TArgs) => factory(args)) as ModuleFactory<string, TArgs, TApi, TOutgoing, TErrors>,
    {
      use(ctx: unknown) {
        const apiMap =
          ctx && typeof ctx === 'object'
            ? (ctx as Record<PropertyKey, unknown>)[MODULE_API_MAP]
            : undefined;

        if (apiMap && typeof apiMap === 'object' && config.key in (apiMap as object)) {
          return (apiMap as Record<PropertyKey, TApi>)[config.key];
        }

        throw new Error(
          `[wskit] ${config.id}.use(ctx) was called outside an active wskit context.`,
        );
      },
      id: config.id,
      __key: config.key,
    },
  );
}
