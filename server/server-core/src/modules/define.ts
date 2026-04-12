/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { ConnectionInfo } from '~/context.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive, PrimitiveRef, RequiresManifest } from '~/primitive.ts';
import type { ScheduledHandle, ScheduledOptions } from '~/scheduled/scheduled.ts';

/**
 * The restricted hook surface modules receive during setup.
 *
 * Unlike built-in primitives that get full `EngineAccess`, modules only get
 * these hooks. This keeps module code sandboxed from engine internals.
 */
export interface ModuleHooks<TCtx = any> {
  /** Observe or rewrite incoming messages before routing. */
  onIncoming(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  /** Observe or rewrite outgoing messages before they are sent. */
  onOutgoing(
    handler: (message: {
      event: string;
      payload: unknown;
    }) => { event: string; payload: unknown } | void,
  ): void;
  /** Run during server startup. */
  onInit(handler: (ctx: any) => void | Promise<void>): void;
  /** Run when a connection is established. */
  onConnect(handler: (ctx: TCtx) => void | Promise<void>): void;
  /** Run when a connection closes. */
  onDisconnect(handler: (ctx: TCtx) => void | Promise<void>): void;
  /** Run during server shutdown. */
  onShutdown(handler: () => void | Promise<void>): void;
  /** Register a scheduled task owned by this module. */
  scheduled<TData>(
    name: string,
    handler: (ctx: any, data: TData) => void | Promise<void>,
    options?: ScheduledOptions<TData>,
  ): ScheduledHandle<TData>;
  /** Create a framework-generated unique ID. */
  generateId(prefix?: string): string;
  /** Read a snapshot of the current connection's state. */
  getState(): ConnectionInfo;
}

/**
 * A function that builds the module's per-connection API from the handler
 * context.
 *
 * This is returned by `setup()` and called once per handler invocation so
 * the module can expose its API through `MyModule.use(ctx)`.
 */
export type ModuleContextFactory<TCtx = any, TApi = unknown> = (ctx: TCtx) => TApi;

/**
 * Configuration object for `defineModule`.
 *
 * - `TArgs` is what the developer passes when calling the module factory
 * - `TApi` is what `MyModule.use(ctx)` returns
 * - `TOutgoing` is the module's own server-to-client events
 * - `TErrors` is the module's typed errors
 */
export interface ModuleConfig<
  TArgs,
  TApi,
  TCtx = any,
  TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> {
  /**
   * A unique identifier in `"author:name"` lowercase format.
   *
   * Example: `"acme:analytics"`, `"wskit:presence"`
   */
  readonly id: string;
  /** A unique symbol used for singleton enforcement and dependency tracking. */
  readonly key: symbol;
  /** Other primitives this module depends on (validated at build time). */
  readonly dependencies?: readonly PrimitiveRef[];
  /** Platform capabilities this module needs (storage, timers, etc.). */
  readonly requires?: RequiresManifest;
  /** Server-to-client events this module may send. */
  readonly outgoing?: TOutgoing;
  /** Typed errors this module may throw. */
  readonly errors?: ErrorsPrimitive<TErrors>;
  /**
   * Called once during engine initialization.
   *
   * Use `hooks` to register lifecycle callbacks and message transforms.
   * Return a context factory that builds the per-connection API object.
   */
  readonly setup: (args: TArgs, hooks: ModuleHooks<TCtx>) => ModuleContextFactory<TCtx, TApi>;
}

/**
 * One registered module instance inside a `defineServer(...)` call.
 *
 * This is what the module factory function returns.
 */
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

/**
 * The return type of `defineModule`.
 *
 * It is both a factory function and a `PrimitiveRef`:
 * - Call it with args to create a module instance for `defineServer`
 * - Use `.use(ctx)` inside handlers to access the module's API
 * - Reference it in `dependencies: [myModule]` to declare a dependency
 */
export interface ModuleFactory<
  TId extends string = string,
  TArgs = unknown,
  TApi = unknown,
  TOutgoing extends readonly OutgoingPrimitive[] = readonly [],
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> extends PrimitiveRef {
  (args: TArgs): ModuleInstance<TId, TArgs, TApi, TOutgoing, TErrors>;
  /**
   * Access this module's API from inside a handler.
   *
   * ```ts
   * incoming(sendMessage, async (ctx, payload) => {
   *   const analytics = MyModule.use(ctx);
   *   analytics.track('message-sent');
   * })
   * ```
   */
  use<TCtx>(ctx: TCtx): TApi;
  readonly id: TId;
}

/**
 * Symbol key the engine uses to attach module API objects to handler contexts.
 *
 * `ModuleFactory.use(ctx)` reads from this key. Product code should never
 * access this directly — use `MyModule.use(ctx)` instead.
 */
export const MODULE_API_MAP = Symbol.for('wskit.moduleApis');

function isModuleId(value: string): boolean {
  return /^[a-z0-9-]+:[a-z0-9-]+$/.test(value);
}

/**
 * Create a reusable module primitive.
 *
 * Modules are third-party or team-shared primitives that plug into wskit
 * through a restricted hook surface. They can observe messages, hook into
 * lifecycle events, register scheduled tasks, and expose a per-connection
 * API.
 *
 * ```ts
 * const ANALYTICS_KEY = Symbol('analytics');
 *
 * const analytics = defineModule({
 *   id: 'acme:analytics',
 *   key: ANALYTICS_KEY,
 *   setup(args, hooks) {
 *     hooks.onConnect((ctx) => { ... });
 *     return (ctx) => ({
 *       track(event: string) { ... },
 *     });
 *   },
 * });
 *
 * // In defineServer:
 * defineServer(analytics({ trackingId: '...' }), ...)
 *
 * // In handlers:
 * const tracker = analytics.use(ctx);
 * tracker.track('message-sent');
 * ```
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
    ((args: TArgs) => {
      return factory(args);
    }) as ModuleFactory<string, TArgs, TApi, TOutgoing, TErrors>,
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
