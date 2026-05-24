/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
import type { ConnectionInfo, InitContext, TaskContext } from '~/context.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { Primitive, PrimitiveRef, RequiresManifest } from '~/primitive.ts';
import type { ScheduledBuilder, ScheduledHandle } from '~/scheduled/scheduled.ts';

/**
 * The hook surface available to a plugin during `setup()`. Everything a
 * plugin can register — lifecycle hooks, message observers, scheduled tasks,
 * and helpers — is exposed here.
 */
export interface PluginHooks<TCtx = any> {
  /**
   * Observe or rewrite the payload of an incoming message before the handler
   * runs. Return a value to replace the payload; return `void` to leave it as
   * is. Routing has already been resolved at this point — the event name is
   * locked, so anything you return becomes the new payload only (the event
   * cannot be redirected from a hook).
   */
  onIncoming(handler: (message: { event: string; payload: unknown }) => unknown | void): void;
  /**
   * Observe or rewrite the payload of an outgoing message before it is sent.
   * Same return contract as `onIncoming`: returned value becomes the new
   * payload, void leaves it untouched, the event name is locked.
   */
  onOutgoing(handler: (message: { event: string; payload: unknown }) => unknown | void): void;

  /** Run during server startup. */
  onInit(handler: (ctx: InitContext) => void | Promise<void>): void;

  /** Run when a connection is established. */
  onConnect(handler: (ctx: TCtx) => void | Promise<void>): void;

  /** Run when a connection closes. */
  onDisconnect(handler: (ctx: TCtx) => void | Promise<void>): void;

  /** Run during server shutdown. */
  onShutdown(handler: () => void | Promise<void>): void;

  /** Register a scheduled task owned by this plugin. */
  scheduled<TData = never, THasData extends boolean = false>(
    name: string,
    callback: (
      builder: ScheduledBuilder<string, TaskContext>,
    ) => ScheduledBuilder<string, TaskContext, TData, THasData, true>,
  ): ScheduledHandle<TData>;

  /** Create a framework-generated unique ID. */
  generateId(prefix?: string): string;

  /** Read a snapshot of the current connection's state. */
  getState(): ConnectionInfo;
}

/**
 * A function that builds the plugin's per-connection API from the handler
 * context.
 *
 * This is returned by `setup()` and called once per handler invocation so
 * the plugin can expose its API through `MyPlugin.use(ctx)`.
 */
export type PluginContextFactory<TCtx = any, TApi = unknown> = (ctx: TCtx) => TApi;

/**
 * Everything a plugin needs to register with the engine: identity, dependencies,
 * platform requirements, the events and errors it exposes, and a `setup`
 * function that wires lifecycle hooks and builds the per-connection API.
 *
 * - `TArgs` is what the developer passes when calling the plugin factory
 * - `TApi` is what `MyPlugin.use(ctx)` returns
 * - `TOutgoing` is the plugin's own server-to-client events
 * - `TErrors` is the plugin's typed errors
 */
export interface PluginConfig<
  TArgs,
  TApi,
  TCtx = any,
  TOutgoing extends Record<string, unknown> = {},
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

  /** Other primitives this plugin depends on (validated at build time). */
  readonly dependencies?: readonly PrimitiveRef[];

  /** Platform capabilities this plugin needs (storage, timers, etc.). */
  readonly requires?: RequiresManifest;

  /** Server-to-client events this plugin may send. */
  readonly outgoing?: TOutgoing;

  /** Typed errors this plugin may throw. */
  readonly errors?: ErrorsPrimitive<TErrors>;

  /**
   * Called once during engine initialization.
   *
   * Use `hooks` to register lifecycle callbacks and message transforms.
   * Return a context factory that builds the per-connection API object.
   */
  readonly setup: (args: TArgs, hooks: PluginHooks<TCtx>) => PluginContextFactory<TCtx, TApi>;
}

/**
 * One registered plugin instance mounted onto a server builder via `.use(...)`.
 *
 * This is what the plugin factory function returns.
 */
export interface PluginInstance<
  TId extends string = string,
  TArgs = unknown,
  TApi = unknown,
  TOutgoing extends Record<string, unknown> = {},
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> extends Primitive<'plugin'> {
  readonly id: TId;
  readonly args: TArgs;

  readonly outgoing: TOutgoing;
  readonly errors?: ErrorsPrimitive<TErrors>;

  readonly setupPlugin: PluginConfig<TArgs, TApi, any, TOutgoing, TErrors>['setup'];
}

/**
 * The return type of `definePlugin`.
 *
 * It is both a factory function and a `PrimitiveRef`:
 * - Call it with args to create a plugin instance to pass into `server(...).use(...)`
 * - Use `.use(ctx)` inside handlers to access the plugin's API
 * - Reference it in `dependencies: [myPlugin]` to declare a dependency
 */
export interface PluginFactory<
  TId extends string = string,
  TArgs = unknown,
  TApi = unknown,
  TOutgoing extends Record<string, unknown> = {},
  TErrors extends readonly ErrorDef<string, any>[] = readonly [],
> extends PrimitiveRef {
  (args: TArgs): PluginInstance<TId, TArgs, TApi, TOutgoing, TErrors>;

  /**
   * Access this plugin's API from inside a handler.
   *
   * ```ts
   * incoming(sendMessage, async (ctx, payload) => {
   *   const analytics = MyPlugin.use(ctx);
   *   analytics.track('message-sent');
   * })
   * ```
   */
  use<TCtx>(ctx: TCtx): TApi;

  readonly id: TId;
}

/**
 * Symbol key the engine uses to attach plugin API objects to handler contexts.
 *
 * `PluginFactory.use(ctx)` reads from this key. Product code should never
 * access this directly — use `MyPlugin.use(ctx)` instead.
 *
 * @internal
 */
export const PLUGIN_API_MAP = Symbol.for('wskit.pluginApis');

function isPluginId(value: string): boolean {
  return /^[a-z0-9-]+:[a-z0-9-]+$/.test(value);
}

/**
 * Create a reusable plugin primitive.
 *
 * Plugins are third-party or team-shared primitives that plug into wskit
 * through a restricted hook surface. They can observe messages, hook into
 * lifecycle events, register scheduled tasks, and expose a per-connection
 * API.
 *
 * Events declared by a plugin are namespaced internally using the plugin's
 * id: an event the plugin sends as `'flushed'` goes onto the wire as
 * `'__acme:analytics:flushed'`. The prefix prevents collisions with
 * user-registered events and with events from other plugins. User code that
 * subscribes to these events directly (for example in a custom client
 * outside wskit's typed clients) sees the prefixed name on the wire — only
 * code reaching events through the plugin's own API sees the short form.
 *
 * ```ts
 * const ANALYTICS_KEY = Symbol('analytics');
 *
 * const analytics = definePlugin({
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
 * // Mount onto a contract:
 * const app = contract<Env>('app')({
 *   plugins: [analytics({ trackingId: '...' })],
 *   definitions: [...],
 * });
 *
 * // In handlers:
 * const tracker = analytics.use(ctx);
 * tracker.track('message-sent');
 * ```
 */
export function definePlugin<
  TArgs,
  TApi,
  TCtx = any,
  const TOutgoing extends Record<string, unknown> = {},
  const TErrors extends readonly ErrorDef<string, any>[] = readonly [],
>(
  config: PluginConfig<TArgs, TApi, TCtx, TOutgoing, TErrors>,
): PluginFactory<string, TArgs, TApi, TOutgoing, TErrors> {
  if (!isPluginId(config.id)) {
    throw new Error(
      `[wskit] Plugin id "${config.id}" is invalid. Use "author:name" lowercase format.`,
    );
  }

  const factory = definePrimitive<
    'plugin',
    [args: TArgs],
    {
      id: string;
      args: TArgs;
      outgoing: TOutgoing;
      errors?: ErrorsPrimitive<TErrors>;
      setupPlugin: PluginConfig<TArgs, TApi, TCtx, TOutgoing, TErrors>['setup'];
    }
  >({
    tag: 'plugin' as const,
    key: config.key,
    kind: 'plugin' as const,
    requires: config.requires,
    create(args: TArgs) {
      return {
        id: config.id,
        args,
        outgoing: (config.outgoing ?? {}) as TOutgoing,
        errors: config.errors,
        setupPlugin: config.setup,
      };
    },
  });

  return Object.assign(
    ((args: TArgs) => {
      return factory(args);
    }) as PluginFactory<string, TArgs, TApi, TOutgoing, TErrors>,
    {
      use(ctx: unknown) {
        const apiMap =
          ctx && typeof ctx === 'object'
            ? (ctx as Record<PropertyKey, unknown>)[PLUGIN_API_MAP]
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
