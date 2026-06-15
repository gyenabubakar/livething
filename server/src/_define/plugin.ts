/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { namespacePluginPrimitives } from '~/_define/plugin-namespace.ts';
import type { AnyCapability, Capability, CapabilityFactory } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerContract, ServerDefinition } from '~/server-definition.ts';

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
  'tag-groups',
  'errors',
  'onInit',
  'onConnect',
  'onDisconnect',
  'onShutdown',
  'onError',
  'onValidationError',
  'onUpgrade',
  // Internal carriers that ride along but need no namespacing.
  'ack',
  'sequence',
  // The server→client request install primitive: a global pending map and ctx
  // install. Outgoing request frames are prefixed by the normal scoped-send
  // path, so the carrier itself needs no per-plugin namespacing.
  'server-requests',
]);

/** Symbol key for a plugin's API-registration primitive. */
const PLUGIN_API_KEY = Symbol('pluginApi');

/** The scoped-handler shape a plugin manifest accepts, carrying its own contract. */
type ScopedHandler<TContract extends ServerContract> = ServerDefinition<
  readonly Primitive[],
  TContract
> & { readonly __scoped?: boolean };

/** The plain-object manifest passed to `plugin(id, ...)`. */
export interface PluginManifest<TContract extends ServerContract = ServerContract, TApi = unknown> {
  /** The plugin's behavior — a scoped handler from `define({ scoped: true }).assemble(...)`. */
  readonly handler: ScopedHandler<TContract>;
  /** Capabilities the host must list. A missing prerequisite is a build error (§21). */
  readonly dependsOn?: readonly CapabilityFactory[];
  /** Per-connection API the host reaches via `ctx.plugin(id)`. Runs against a plugin-scoped ctx. */
  readonly api?: (ctx: any) => TApi;
}

/**
 * The contract slice a plugin contributes to the host, surfaced on
 * `InferClient.plugins[id]`. It carries the plugin's own scoped contract in
 * server perspective and the type of `ctx.plugin(id)`; `InferClient` flips the
 * contract into the client's view under short (un-prefixed) names.
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
> extends Capability<{ plugins: { [K in TId]: PluginContractSlice<TContract, TApi> } }, never> {
  /** The plugin's id, for identification at assembly. @internal */
  readonly __pluginId: string;
  /** Capabilities the host must list; a missing one is a build error. @internal */
  readonly __pluginDependsOn: readonly CapabilityFactory[];
}

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
      'Host-owned engines (dedup, persistence, replay, rateLimit, …) belong on the host — list ' +
      'them there and reach them from the plugin with dependsOn.',
  );
}

/**
 * Verify that every plugin listed in a host's `capabilities[]` has its
 * `dependsOn` prerequisites satisfied by another listed capability (§21, §25).
 * A missing prerequisite is a build error at `assemble()`, never a runtime
 * surprise.
 *
 * Matching is by stable capability identity: each factory and the capability it
 * produces share a `__capabilityKind` token (see `withCapabilityKind` /
 * `stampKind`). The matcher reads the token off each `dependsOn` factory WITHOUT
 * calling it — so an arg-requiring factory such as `keepalive` never crashes —
 * and compares against the tokens of the host's listed capabilities. Distinct
 * tokens per stream variant mean `dependsOn: [resumableStream]` is never
 * satisfied by a host that lists only `stream()`.
 */
export function assertPluginDependencies(capabilities: readonly AnyCapability[]): void {
  const present = new Set<string>();
  for (const cap of capabilities) {
    if (cap.__capabilityKind) present.add(cap.__capabilityKind);
  }

  for (const cap of capabilities) {
    const pluginCap = cap as Partial<PluginCapability>;
    if (!pluginCap.__pluginId || !pluginCap.__pluginDependsOn) continue;
    for (const factory of pluginCap.__pluginDependsOn) {
      if (factory.__capabilityKind && present.has(factory.__capabilityKind)) continue;
      throw new Error(
        `[wskit] plugin('${pluginCap.__pluginId}') depends on a capability the host does not ` +
          'list. Add the required capability to define({ capabilities: [...] }) — a plugin ' +
          'declares prerequisites via dependsOn instead of owning host engines.',
      );
    }
  }
}

/**
 * Wrap a scoped handler and a manifest into a capability you list in
 * `define({ capabilities: [...] })`. The plugin's events, requests, and emits
 * are namespaced under `__<id>::`, and its `api` is reached from any host
 * handler as `ctx.plugin('<id>')`.
 *
 * The behavior is authored as a real, independently-bootable handler with
 * `define({ scoped: true })`, so a plugin is tested like a tiny app.
 *
 * @example
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 * import { plugin } from '@wskit/server/plugin';
 * import * as v from 'valibot';
 *
 * const h = define({
 *   scoped: true,
 *   capabilities: [emits({ 'user-online': t<{ id: string }>() })],
 * });
 * const heartbeat = h.on('heartbeat', {
 *   input: v.object({}),
 *   run(ctx) { ctx.send('user-online', { id: ctx.id }); },
 * });
 *
 * export const Presence = plugin('acme:presence', {
 *   handler: h.assemble(heartbeat),
 *   api: (ctx) => ({ ping() { ctx.send('user-online', { id: ctx.id }); } }),
 * });
 * ```
 */
export function plugin<const TId extends string, TContract extends ServerContract, TApi = unknown>(
  id: TId,
  manifest: PluginManifest<TContract, TApi>,
): PluginCapability<TId, TContract, TApi> {
  if (!PLUGIN_ID.test(id)) {
    throw new Error(`[wskit] Plugin id '${id}' is invalid. Use lowercase 'author:name' format.`);
  }
  if (!manifest.handler.__scoped) {
    throw new Error(
      `[wskit] plugin('${id}') handler must be built with define({ scoped: true }). ` +
        'Author the plugin as a scoped handler, then pass its assemble() result here.',
    );
  }

  for (const primitive of manifest.handler.primitives) assertSupported(id, primitive);

  const namespaced = namespacePluginPrimitives(id, manifest.handler.primitives);
  const primitives: Primitive[] = [...namespaced];
  if (manifest.api) primitives.push(pluginApiPrimitive(id, manifest.api));

  const cap = capability<{ plugins: { [K in TId]: PluginContractSlice<TContract, TApi> } }, never>(
    primitives,
  ) as PluginCapability<TId, TContract, TApi>;
  const writable = cap as {
    __pluginId: string;
    __pluginDependsOn: readonly CapabilityFactory[];
  };
  writable.__pluginId = id;
  writable.__pluginDependsOn = manifest.dependsOn ?? [];
  return cap;
}
