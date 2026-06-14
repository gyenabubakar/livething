/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { namespacePluginPrimitives } from '~/_define/plugin-namespace.ts';
import type { AnyCapability, Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { ServerDefinition } from '~/server-definition.ts';

/** A plugin id must be lowercase `author:name`. */
const PLUGIN_ID = /^[a-z0-9-]+:[a-z0-9-]+$/;

/** The primitive kinds a plugin's scoped handler may contribute in this phase. */
const ALLOWED_PLUGIN_KINDS = new Set(['incoming', 'request', 'outgoing']);

/** Symbol key for a plugin's API-registration primitive. */
const PLUGIN_API_KEY = Symbol('pluginApi');

/** The plain-object manifest passed to `plugin(id, ...)`. */
export interface PluginManifest<TApi = unknown> {
  /** The plugin's behavior — a scoped handler from `define({ scoped: true }).assemble(...)`. */
  readonly handler: ServerDefinition<readonly Primitive[], any> & { readonly __scoped?: boolean };
  /** Capabilities the host must list. Accepted now; enforced in a later phase. */
  readonly dependsOn?: readonly (() => AnyCapability)[];
  /** Per-connection API the host reaches via `ctx.plugin(id)`. Runs against a plugin-scoped ctx. */
  readonly api?: (ctx: any) => TApi;
}

/** A capability produced by `plugin(...)` — registers the plugin's namespaced surface. */
export interface PluginCapability extends Capability<{}, never> {
  /** The plugin's id, for identification at assembly. @internal */
  readonly __pluginId: string;
  /** Capabilities the host must list (enforced in a later phase). @internal */
  readonly __pluginDependsOn: readonly (() => AnyCapability)[];
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

/** Reject any plugin primitive this phase does not handle, with a pointed message. */
function assertSupported(id: string, primitive: Primitive): void {
  if (ALLOWED_PLUGIN_KINDS.has(primitive.__wskit)) return;
  throw new Error(
    `[wskit] plugin('${id}') uses '${primitive.__wskit}', which a plugin cannot contribute yet. ` +
      'Plugins currently support on / request / emits handlers; lifecycle, channels, streams, ' +
      'scheduled tasks, tags, and errors inside a plugin land in a later phase. Host-owned ' +
      'engines (ack, dedup, persistence, …) belong on the host — list them there and use dependsOn.',
  );
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
export function plugin<TApi = unknown>(
  id: string,
  manifest: PluginManifest<TApi>,
): PluginCapability {
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

  const cap = capability<{}, never>(primitives) as PluginCapability;
  const writable = cap as {
    __pluginId: string;
    __pluginDependsOn: readonly (() => AnyCapability)[];
  };
  writable.__pluginId = id;
  writable.__pluginDependsOn = manifest.dependsOn ?? [];
  return cap;
}
