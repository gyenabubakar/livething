/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { namespacePluginPrimitives } from '~/_define/plugin-namespace.ts';
import { scopePluginContext } from '~/plugin-scope.ts';
import type {
  AnyCapability,
  Capability,
  CapabilityFactory,
  UnionToIntersection,
} from '~/_define/capability.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ClientPluginContract } from '~/infer-client.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';

/**
 * A host capability factory accepted by a plugin's `dependsOn` — only the
 * host-owned engines (`dedup`, `sequence`, `keepalive`, `rateLimit`,
 * `replay`), which carry `__hostOnly: true`. A behavior capability
 * a plugin can own itself (`requests`, `channels`, streams, …) is not assignable
 * and is rejected at compile time: a plugin lists those in its own
 * `capabilities` rather than depending on the host for them. Plugin factories
 * are excluded too — they carry no `__hostOnly`.
 */
type HostCapabilityFactory = ((...args: any[]) => AnyCapability & {
  readonly __hostOnly: true;
}) & { readonly __capabilityKind?: string };

/** A plugin id must be lowercase `author:name`. */
const PLUGIN_ID = /^[a-z0-9-]+:[a-z0-9-]+$/;

/** The primitive kinds a plugin's scoped handler may contribute. */
const ALLOWED_PLUGIN_KINDS = new Set([
  'incoming',
  'request',
  'outgoing',
  'stream-generate',
  'resumable-stream-generate',
  'recorded-stream-generate',
  'channel',
  'scheduled',
  'scheduledSurface',
  'tag-groups',
  'tag-persistence-runtime',
  'errors',
  'onInit',
  'onConnect',
  'onDisconnect',
  'onShutdown',
  'onError',
  'onValidationError',
  'onUpgrade',
  'onPing',
  'onPong',
  // Observers that ride along stamped with their owner, not namespaced events.
  'intercept',
  'outgoingHook',
  // Internal carriers that ride along but need no namespacing.
  'sequence',
  // The server→client request install primitive: a global pending map and ctx
  // install. Outgoing request frames are prefixed by the normal scoped-send
  // path, so the carrier itself needs no per-plugin namespacing.
  'server-requests',
  'request-runtime',
  'stream-runtime',
  'resumable-stream-runtime',
  'recorded-stream-runtime',
  'intercept-runtime',
  'channel-runtime',
]);

/** Symbol key for a plugin's API-registration primitive. */
const PLUGIN_API_KEY = Symbol('pluginApi');

/** Symbol key so the `ctx.plugin` accessor installs once, however many plugins are listed. */
const PLUGIN_SURFACE_KEY = Symbol('pluginSurface');

/**
 * Build the `ctx.plugin(id)` accessor for one connection context. It runs the
 * registered plugin's API factory against a plugin-scoped context (sends prefixed
 * with the plugin namespace) and caches the result by id, so repeated calls in
 * one context return the same API object and the factory runs at most once.
 */
function buildPluginAccessor(engine: EngineAccess, baseCtx: unknown): Record<string, unknown> {
  const base = baseCtx as Record<PropertyKey, unknown>;
  const pluginApiCache = new Map<string, unknown>();
  return {
    plugin: (id: string) => {
      if (pluginApiCache.has(id)) return pluginApiCache.get(id);
      const factory = engine.getPluginApiFactory(id);
      if (!factory) {
        throw new Error(
          `[wskit] ctx.plugin('${id}') — no plugin with id '${id}' is registered. ` +
            'List the plugin in define({ capabilities: [...] }).',
        );
      }
      const api = factory(scopePluginContext(id, base));
      pluginApiCache.set(id, api);
      return api;
    },
  };
}

/**
 * Build the primitive every plugin contributes to install the `ctx.plugin`
 * accessor. Keyed so listing several plugins still installs it once, and present
 * on a server iff at least one plugin is listed.
 */
function pluginSurfacePrimitive(): Primitive {
  return {
    __wskit: 'pluginSurface',
    __kind: 'plugin',
    __identity: [PLUGIN_SURFACE_KEY],
    __requires: {},
    __setup(engine) {
      engine.installOnce(PLUGIN_SURFACE_KEY, () => {
        engine.extendContext((baseCtx) => buildPluginAccessor(engine, baseCtx));
      });
    },
  };
}

/**
 * The scoped-handler shape a plugin manifest accepts, carrying its own contract,
 * ctx, and — when the scoped `assemble({ handlers, api })` declared one — its api
 * factory. `plugin(id, { handler })` reads the api off the handler, so the api is
 * authored in one place next to the handlers it wraps. Its environment requirement
 * is carried by the scoped context type.
 */
type ScopedHandler<
  TContract extends ServerContract,
  TScopedCtx = unknown,
  TApi = unknown,
> = ServerDefinition<readonly Primitive[], TContract, TScopedCtx, TApi> & {
  readonly __scoped?: boolean;
};

/** Reads the environment type from a plugin's scoped connection context. */
type EnvOfScopedContext<TScopedCtx> = TScopedCtx extends { readonly env: infer TEnv }
  ? TEnv
  : unknown;

/** The plain-object manifest passed to `plugin(id, ...)`. */
export interface PluginManifest<
  TContract extends ServerContract = ServerContract,
  TApi = unknown,
  TScopedCtx = unknown,
> {
  /**
   * The plugin's behavior — a scoped handler from
   * `define({ scope: 'plugin' }).assemble({ handlers, api })`. Any `api` the host
   * reaches via `ctx.plugin(id)` is authored on that `assemble`, not here.
   */
  readonly handler: ScopedHandler<TContract, TScopedCtx, TApi>;
  /**
   * Host capability factories the host must list (e.g. `requests`, `rateLimit`).
   * A missing prerequisite is a build error. Only host capability factories are
   * accepted — a plugin factory is rejected at compile time, because the
   * dependency matcher reads a host capability's identity token, which plugin
   * factories don't carry (they would always fail the check at runtime).
   */
  readonly dependsOn?: readonly HostCapabilityFactory[];
  /**
   * Opt the plugin's `intercept`/`outgoing` hooks into seeing the host app's
   * frames, not just the plugin's own. Off by default (least privilege): a
   * plugin observes only its own namespaced traffic. When this is the literal
   * `true`, listing the produced capability bare is a type error — wrap it in
   * `observeHost(...)` to grant the privilege explicitly. A plugin never sees
   * another plugin's frames.
   */
  readonly observesHostTraffic?: boolean;
}

/**
 * The contract slice a plugin contributes to the host. It carries the plugin's
 * own scoped contract in server perspective and the type of `ctx.plugin(id)`.
 * `InferClient` flips the contract into the client's view and folds every event
 * into the top-level client maps under its `__<id>::` wire name; the `api` feeds
 * the server ctx's `ctx.plugin(id)`.
 */
export interface PluginContractSlice<TContract extends ServerContract, TApi> {
  /** The plugin's own scoped contract, in server perspective. @internal */
  readonly __contract: TContract;
  /** The type of `ctx.plugin(id)` for this plugin. @internal */
  readonly __api: TApi;
}

/**
 * A capability produced by `plugin(...)` — registers the plugin's namespaced
 * surface and declares its slice under the host's `plugins` contract slot.
 */
export interface PluginCapability<
  TId extends string = string,
  TContract extends ServerContract = ServerContract,
  TApi = unknown,
  TObservesHost extends boolean = false,
  TEnv = unknown,
> extends Capability<{ plugins: { [K in TId]: PluginContractSlice<TContract, TApi> } }, never> {
  /** Type-only environment requirement inherited from the plugin's scoped definition. */
  readonly __pluginEnv?: TEnv;
  /** The plugin's id, for identification at assembly. @internal */
  readonly __pluginId: string;
  /** Capabilities the host must list; a missing one is a build error. @internal */
  readonly __pluginDependsOn: readonly CapabilityFactory[];
  /**
   * Capability identity tokens the host must provide: the explicit `dependsOn`
   * plus the host-owned requirements auto-derived from the plugin's own
   * capabilities. Checked at the host's `assemble()`. @internal
   */
  readonly __pluginRequiredKinds: readonly string[];
  /** Whether the plugin opted its hooks into observing host traffic. @internal */
  readonly __observesHostTraffic: boolean;
  /** Set once `observeHost(...)` wraps this capability; the runtime grant gate reads it. @internal */
  readonly __hostObservationGranted?: boolean;
  /**
   * Phantom brand present only when `observesHostTraffic` is the literal `true`
   * and the capability has not been wrapped by `observeHost(...)`. The app's
   * `define({ capabilities })` element type rejects it, so a bare listing is a
   * compile error; `observeHost(...)` strips it. Never set at runtime. @internal
   */
  readonly __requiresHostGrant?: [TObservesHost] extends [true]
    ? 'This plugin observes host traffic — wrap it in observeHost(...) to grant the privilege.'
    : never;
}

/** The environment requirement carried by one capability, or `unknown` when absent. */
export type PluginEnvOf<TCapability> =
  TCapability extends PluginCapability<any, any, any, any, infer TEnv> ? TEnv : unknown;

/** The combined environment requirement of all plugin capabilities in a host. */
export type PluginEnvRequirements<TCaps extends readonly AnyCapability[]> = UnionToIntersection<
  PluginEnvOf<TCaps[number]>
>;

/**
 * A capability the app's `define({ capabilities })` accepts: any capability,
 * except one still carrying the `__requiresHostGrant` brand of an ungranted
 * host-observing plugin. Wrapping that plugin in `observeHost(...)` strips the
 * brand and makes it assignable.
 */
export type GrantableCapability = AnyCapability & {
  readonly __requiresHostGrant?: never;
};

/**
 * The client-side contract for a server plugin — its own events, requests,
 * streams, and channels flipped into the client's perspective, with plain names.
 * A client plugin author passes this to `plugin<...>()` instead of hand-writing
 * the contract, so the two halves stay in step:
 *
 * Derive it beside the server plugin and export the result, the way `InferClient`
 * is used for a whole app. The client half then imports one plain type.
 *
 * ```ts
 * // server plugin
 * export const Presence = plugin('acme:presence', { handler, api });
 * export type PresenceWire = InferPluginClient<typeof Presence>;
 *
 * // client plugin
 * import type { PresenceWire } from './server-plugin';
 *
 * const PresenceClient = plugin<PresenceWire, PresenceApi>()({
 *   id: 'acme:presence',
 *   setup(socket) { ... },
 * });
 * ```
 *
 * Accepts either the plugin factory (`typeof Presence`) or the capability it
 * returns (`ReturnType<typeof Presence>`).
 */
export type InferPluginClient<TPlugin> = TPlugin extends () => PluginCapability<
  string,
  infer TContract,
  unknown,
  boolean
>
  ? ClientPluginContract<TContract>
  : TPlugin extends PluginCapability<string, infer TContract, unknown, boolean>
    ? ClientPluginContract<TContract>
    : never;

/** Build the primitive whose `__setup` registers the plugin's API factory with the engine. */
function pluginApiPrimitive(id: string, factory: (ctx: any) => unknown): Primitive {
  return {
    __wskit: 'pluginApi',
    __kind: 'plugin',
    __identity: [PLUGIN_API_KEY, id],
    __requires: {},
    __setup(engine) {
      engine.registerPluginApi(id, factory);
    },
  };
}

/** Reject any plugin primitive a plugin cannot contribute, with a pointed message. */
function assertSupported(id: string, primitive: Primitive): void {
  if (ALLOWED_PLUGIN_KINDS.has(primitive.__wskit)) return;
  throw new Error(
    `[wskit] plugin('${id}') uses '${primitive.__wskit}', which a plugin cannot contribute. ` +
      'Host-owned engines (dedup, replay, rateLimit, …) belong on the host — list ' +
      'them there and reach them from the plugin with dependsOn.',
  );
}

/**
 * Wrap a scoped handler and a manifest into a capability you list in
 * `define({ capabilities: [...] })`. The plugin's events, requests, and emits
 * are namespaced under `__<id>::`, and its `api` is reached from any host
 * handler as `ctx.plugin('<id>')`.
 *
 * The behavior is authored as a real, independently-bootable handler with
 * `define({ scope: 'plugin' })`, so a plugin is tested like a tiny app.
 *
 * @example
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 * import { plugin } from '@wskit/server/plugin';
 * import * as v from 'valibot';
 *
 * const h = define({
 *   scope: 'plugin',
 *   capabilities: [emits({ 'user-online': t<{ id: string }>() })],
 * });
 * const heartbeat = h.on('heartbeat', {
 *   input: v.object({}),
 *   run(ctx) { ctx.send('user-online', { id: ctx.connection.id }); },
 * });
 *
 * // The api is authored on the scoped assemble, next to its handlers.
 * const presence = h.assemble({
 *   handlers: [heartbeat],
 *   api: (ctx) => ({ ping() { ctx.send('user-online', { id: ctx.connection.id }); } }),
 * });
 *
 * export const Presence = plugin('acme:presence', { handler: presence });
 *
 * // register it like any other capability — the factory is invoked
 * define({ capabilities: [Presence()] });
 * ```
 */
export function plugin<
  const TId extends string,
  TContract extends ServerContract,
  TApi = unknown,
  const TObservesHost extends boolean = false,
  TScopedCtx = unknown,
>(
  id: TId,
  manifest: PluginManifest<TContract, TApi, TScopedCtx> & {
    readonly observesHostTraffic?: TObservesHost;
  },
): () => PluginCapability<
  TId,
  TContract,
  TApi,
  [TObservesHost] extends [true] ? true : false,
  EnvOfScopedContext<TScopedCtx>
> {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`[wskit] Plugin id '${id}' is invalid. Use lowercase 'author:name' format.`);
  }
  if (!manifest.handler.__scoped) {
    throw new Error(
      `[wskit] plugin('${id}') handler must be built with define({ scope: 'plugin' }). ` +
        'Author the plugin as a scoped handler, then pass its assemble() result here.',
    );
  }

  for (const primitive of manifest.handler.primitives) assertSupported(id, primitive);

  const observesHostTraffic = manifest.observesHostTraffic ?? false;
  const namespaced = namespacePluginPrimitives(
    id,
    manifest.handler.primitives,
    observesHostTraffic,
  );
  const primitives: Primitive[] = [...namespaced, pluginSurfacePrimitive()];
  const apiFactory = (manifest.handler as { __apiFactory?: (ctx: unknown) => unknown })
    .__apiFactory;
  if (apiFactory) primitives.push(pluginApiPrimitive(id, apiFactory));

  const cap = capability<{ plugins: { [K in TId]: PluginContractSlice<TContract, TApi> } }, never>(
    primitives,
  ) as PluginCapability<
    TId,
    TContract,
    TApi,
    [TObservesHost] extends [true] ? true : false,
    EnvOfScopedContext<TScopedCtx>
  >;
  const writable = cap as {
    __pluginId: string;
    __pluginDependsOn: readonly CapabilityFactory[];
    __pluginRequiredKinds: readonly string[];
    __observesHostTraffic: boolean;
  };
  writable.__pluginId = id;
  writable.__pluginDependsOn = manifest.dependsOn ?? [];
  // Host requirements = explicit dependsOn + what the plugin's own capabilities
  // imply, recorded at assemble.
  const explicitKinds = (manifest.dependsOn ?? [])
    .map((factory) => factory.__capabilityKind)
    .filter((kind): kind is string => typeof kind === 'string');
  const autoKinds =
    (manifest.handler as { __hostDependencies?: readonly string[] }).__hostDependencies ?? [];
  writable.__pluginRequiredKinds = [...new Set([...explicitKinds, ...autoKinds])];
  writable.__observesHostTraffic = observesHostTraffic;
  // A fresh capability is returned each call, so wrapping one in observeHost(...)
  // never mutates another listing of the same plugin.
  return () => ({ ...cap }) as typeof cap;
}

/**
 * Grant a host-observing plugin permission to see the host app's frames. Wrap
 * the called plugin capability — `observeHost(Metrics())` — and list the result
 * in `define({ capabilities: [...] })`.
 *
 * A plugin built with `observesHostTraffic: true` (literal) is a type error when
 * listed bare; `observeHost(...)` strips the brand and marks the grant so the
 * runtime gate at `assemble()` is satisfied.
 *
 * @example
 * ```ts
 * import { observeHost } from '@wskit/server/plugin';
 * define({ capabilities: [observeHost(Metrics())] });
 * ```
 */
export function observeHost<TCap extends { readonly __pluginId: string }>(
  granted: TCap,
): Omit<TCap, '__requiresHostGrant'> & { readonly __hostObservationGranted: true } {
  (granted as unknown as { __hostObservationGranted: boolean }).__hostObservationGranted = true;
  return granted as unknown as Omit<TCap, '__requiresHostGrant'> & {
    readonly __hostObservationGranted: true;
  };
}
