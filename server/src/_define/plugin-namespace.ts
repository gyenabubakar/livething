/* oxlint-disable @typescript-eslint/no-explicit-any */
import { namespaceError } from '@livething/core';
import {
  pluginWireName,
  scopePluginContext,
  scopePluginThrow,
  scopeUpgradeHelpers,
} from '~/plugin-scope.ts';
import { serverRequestKey } from '~/request/outgoing-runtime.ts';
import type { ErrorDefWithFactory } from '@livething/core';
import type { EngineAccess } from '~/_engine/access.ts';
import type { ScopeDeclaration } from '~/channel/channel.ts';
import type { UpgradeHandler, UpgradeResult } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { ResolvedServerRequest } from '~/request/server-requests.ts';

/** The primitive kinds that route or declare by a plain `event` field. */
const EVENT_KINDS = new Set([
  'incoming',
  'request',
  'outgoing',
  'stream-generate',
  'resumable-stream-generate',
  'recorded-stream-generate',
]);

/**
 * A channel's lifecycle children carry a `handler` and run user code against a
 * ctx, so their sends must be plugin-scoped like any handler. Each maps to the
 * `EngineAccess` method that registers it, with `onCheck` taking the validator.
 */
const CHANNEL_LIFECYCLE_REGISTER: Record<
  string,
  (engine: EngineAccess, handler: (ctx: any, ...rest: any[]) => any, primitive: any) => void
> = {
  check: (engine, handler, primitive) => engine.onCheck(handler, primitive.validator),
  revalidate: (engine, handler) => engine.onRevalidate(handler),
  commit: (engine, handler) => engine.onCommit(handler),
  onSubscribe: (engine, handler) => engine.onSubscribe(handler),
  onUnsubscribe: (engine, handler) => engine.onUnsubscribe(handler),
  onSessionEnd: (engine, handler) => engine.onSessionEnd(handler),
};

/** Plugin-contributed lifecycle primitives → the engine registry kind they map to. */
const LIFECYCLE_KINDS: Record<string, PluginLifecycleKind> = {
  onInit: 'init',
  onConnect: 'connect',
  onDisconnect: 'disconnect',
  onShutdown: 'shutdown',
  onError: 'error',
  onValidationError: 'validationError',
  onPing: 'ping',
  onPong: 'pong',
};

type PluginLifecycleKind =
  | 'init'
  | 'connect'
  | 'disconnect'
  | 'shutdown'
  | 'error'
  | 'validationError'
  | 'ping'
  | 'pong';

/** A plugin's id paired with the short error codes it declared. */
interface PluginScope {
  id: string;
  shortCodes: Set<string>;
}

/**
 * Collect the SHORT error codes a plugin declares across its `errors([...])`
 * primitives, so user code that throws one of these (its local factory carries
 * the short code) can be rewritten to the namespaced wire code before it leaves
 * the plugin's scope.
 */
function collectShortErrorCodes(primitives: readonly Primitive[]): Set<string> {
  const codes = new Set<string>();
  for (const primitive of primitives) {
    if (primitive.__livething !== 'errors') continue;

    const defs = (primitive as unknown as { defs: ErrorDefWithFactory<string, any>[] }).defs;
    for (const def of defs) codes.add(def.code);
  }

  return codes;
}

/** Rewrite one routable primitive into its namespaced form for plugin `id`. */
function namespaceOne(scope: PluginScope, primitive: Primitive): Primitive {
  const { id, shortCodes } = scope;
  if (!EVENT_KINDS.has(primitive.__livething)) return primitive;

  const event = (primitive as { event?: string }).event;
  if (event === undefined) return primitive;

  const wireEvent = pluginWireName(id, event);
  const [key] = primitive.__identity;
  const copy: Record<PropertyKey, unknown> = {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    event: wireEvent,
    __identity: [key, wireEvent],
    // Provenance marker: this event is framework-namespaced for a plugin, so the
    // compile-time reserved-name guards allow its `__`/`::` form. A user-declared
    // event never carries this, so it can't slip a reserved name past the guards.
    __plugin: id,
  };

  // Stream generators namespace their nudge event names too, so the client
  // reaches them at `__<id>::<nudge>` and the compile guards allow the form.
  const stream = (primitive as { stream?: { nudges?: { event: string }[] } }).stream;
  if (stream?.nudges) {
    copy.stream = {
      ...stream,
      nudges: stream.nudges.map((n) => ({ ...n, event: pluginWireName(id, n.event) })),
    };
  }

  const nudges = (primitive as { nudges?: { event: string }[] }).nudges;
  if (nudges) {
    copy.nudges = nudges.map((n) => ({ ...n, event: pluginWireName(id, n.event) }));
  }

  const handler = (primitive as { handler?: (ctx: any, payload: any) => unknown }).handler;
  if (handler) {
    copy.handler = scopePluginThrow(id, shortCodes, (ctx: any, payload: any) =>
      handler(scopePluginContext(id, ctx), payload),
    );
  }

  const run = (primitive as { run?: (ctx: any, ...rest: any[]) => unknown }).run;
  if (run) {
    copy.run = scopePluginThrow(id, shortCodes, (ctx: any, ...rest: any[]) =>
      run(scopePluginContext(id, ctx), ...rest),
    );
  }

  return copy as unknown as Primitive;
}

/**
 * Rebuild a plugin's lifecycle primitive so it registers into the plugin
 * lifecycle registry — kept apart from the app's hooks so the engine can run it
 * in onion order. The handler runs against a plugin-scoped context, so its
 * sends are namespaced like any other plugin send.
 */
function namespaceLifecycle(
  scope: PluginScope,
  kind: PluginLifecycleKind,
  primitive: Primitive,
): Primitive {
  const { id, shortCodes } = scope;
  const handler = (primitive as unknown as { handler: (ctx: any, ...rest: any[]) => unknown })
    .handler;
  const scoped = scopePluginThrow(
    id,
    shortCodes,
    (ctx: any, ...rest: any[]): void | Promise<void> =>
      handler(scopePluginContext(id, ctx), ...rest) as void | Promise<void>,
  );
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    handler: scoped,
    __setup(engine: EngineAccess) {
      engine.registerPluginLifecycle(kind, id, scoped);
    },
  } as unknown as Primitive;
}

/** The bare definition key a channel primitive was built under (static name or family key). */
function channelBareKey(primitive: Primitive): string {
  const pattern = (primitive as unknown as { pattern: string | { key: string } }).pattern;
  return typeof pattern === 'string' ? pattern : pattern.key;
}

/**
 * Re-key a plugin's server→client request declarations to their `__<id>::` wire
 * names. The requests builder files each declaration under the bare event (and,
 * for a channel's `serverRequests(...)`, the bare channel key) at build time —
 * before namespacing — so the runtime, which resolves a plugin request by its
 * prefixed event / prefixed channel key, would miss the entry: a broadcast
 * request is wrongly rejected and a targeted one skips response validation. We
 * walk the carrier's declaration map (keyed `serverRequestKey(channelKey, event)`),
 * prefix every event, prefix a channel key when it belongs to one of this
 * plugin's channels, and rewrite the map in place so both lookups land.
 */
function renamedServerRequests(
  id: string,
  primitives: readonly Primitive[],
): ReadonlyMap<Primitive, Map<string, ResolvedServerRequest>> {
  const renamed = new Map<Primitive, Map<string, ResolvedServerRequest>>();

  const pluginChannelKeys = new Set(
    primitives.filter((p) => p.__livething === 'channel').map(channelBareKey),
  );

  for (const primitive of primitives) {
    if (primitive.__livething !== 'server-requests') continue;

    const map = (primitive as { __serverRequests?: ReadonlyMap<string, ResolvedServerRequest> })
      .__serverRequests;
    if (!map || map.size === 0) continue;

    // Build a fresh map; never mutate the carrier in `manifest.definition.primitives`
    // (keeps namespacing idempotent and copy-don't-mutate like the other helpers).
    const next = new Map<string, ResolvedServerRequest>();
    for (const [key, value] of map) {
      const [channelKey, event] = JSON.parse(key) as [string | null, string];
      const nextChannelKey =
        channelKey !== null && pluginChannelKeys.has(channelKey)
          ? pluginWireName(id, channelKey)
          : channelKey;
      next.set(serverRequestKey(nextChannelKey, pluginWireName(id, event)), value);
    }

    renamed.set(primitive, next);
  }

  return renamed;
}

/**
 * Namespace every routable primitive a plugin contributes so its events,
 * requests, streams, and emits live under `__<id>::` and can't collide with the
 * host's or another plugin's, and reroute its lifecycle hooks into the onion
 * registry. Non-namespaced primitives pass through untouched.
 */
export function namespacePluginPrimitives(
  id: string,
  primitives: readonly Primitive[],
): Primitive[] {
  const scope: PluginScope = { id, shortCodes: collectShortErrorCodes(primitives) };
  const serverRequests = renamedServerRequests(id, primitives);
  return primitives.map((primitive) => {
    const declarations = serverRequests.get(primitive);
    if (primitive.__livething === 'server-requests' && declarations) {
      return (
        primitive as Primitive & {
          __withServerRequests: (requests: ReadonlyMap<string, ResolvedServerRequest>) => Primitive;
        }
      ).__withServerRequests(declarations);
    }

    if ((primitive as { __scopedUpgrade?: boolean }).__scopedUpgrade) {
      return namespaceUpgrade(id, primitive);
    }

    const lifecycleKind = LIFECYCLE_KINDS[primitive.__livething];
    if (lifecycleKind) return namespaceLifecycle(scope, lifecycleKind, primitive);

    if (primitive.__livething === 'scheduled') return namespaceScheduled(scope, primitive);

    if (primitive.__livething === 'channel') return namespaceChannel(scope, primitive);

    if (primitive.__livething === 'tag-groups') return namespaceTagGroups(id, primitive);

    if (primitive.__livething === 'errors') return namespaceErrors(id, primitive);

    if (primitive.__livething === 'intercept') return ownHook(scope, primitive);

    if (primitive.__livething === 'outgoingHook') return ownOutgoingHook(scope, primitive);

    return namespaceOne(scope, primitive);
  });
}

/**
 * Scope a hook's ctx so its sends, kv keys, tags, channel sends, requests, and
 * scheduled tasks are namespaced like any other plugin call — the same wrapping
 * the normal handler path uses. An outgoing hook can run with no per-connection
 * ctx (e.g. during a broadcast), so a nullish ctx passes through untouched
 * rather than being proxied.
 */
function scopeHookCtx(id: string, ctx: any): any {
  return ctx == null ? ctx : scopePluginContext(id, ctx);
}

/**
 * Stamp an intercept with its plugin owner and run it against a plugin-scoped
 * ctx. An intercept declares no event, so its event is not rewritten; its ctx
 * is namespaced so a hook can emit the plugin's own events and write its own kv.
 */
function ownHook(scope: PluginScope, primitive: Primitive): Primitive {
  const { id, shortCodes } = scope;
  const handler = (primitive as unknown as { handler: (ctx: any, frame: any) => unknown }).handler;
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    handler: scopePluginThrow(id, shortCodes, (ctx: any, frame: any) =>
      handler(scopeHookCtx(id, ctx), frame),
    ),
    __owner: { kind: 'plugin', id },
  } as unknown as Primitive;
}

/**
 * Stamp an outgoing hook with its plugin owner, run it against a plugin-scoped
 * ctx, and rebuild its `__setup` so it registers with that owner. Like an
 * intercept, it declares no event, so its event is not rewritten.
 */
function ownOutgoingHook(scope: PluginScope, primitive: Primitive): Primitive {
  const { id, shortCodes } = scope;
  const origHandler = (primitive as unknown as { handler: (ctx: any, frame: any) => unknown })
    .handler;
  const handler = scopePluginThrow(id, shortCodes, (ctx: any, frame: any) =>
    origHandler(scopeHookCtx(id, ctx), frame),
  );
  const owner = { kind: 'plugin' as const, id };

  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __owner: { kind: 'plugin', id },
    __setup(engine: EngineAccess) {
      engine.onOutgoing(handler, owner);
    },
  } as unknown as Primitive;
}

/**
 * Namespace a plugin's scheduled task so it registers under `__<id>::<task>` and
 * its body runs in a plugin-scoped context (sends prefixed; `ctx.schedule(...)`
 * resolves to the namespaced id).
 */
function namespaceScheduled(scope: PluginScope, primitive: Primitive): Primitive {
  const { id, shortCodes } = scope;
  const taskId = (primitive as unknown as { taskId: string }).taskId;
  const wireTask = pluginWireName(id, taskId);
  const [key] = primitive.__identity;
  const handler = (primitive as unknown as { handler: (ctx: any, data?: any) => unknown }).handler;

  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    taskId: wireTask,
    __identity: [key, wireTask],
    __plugin: id,
    handler: scopePluginThrow(id, shortCodes, (ctx: any, data?: any) =>
      handler(scopePluginContext(id, ctx), data),
    ),
  } as unknown as Primitive;
}

/**
 * Namespace a plugin's tag groups so each group declares under `__<id>::<group>`.
 * The provenance marker lets the engine register `::`-bearing names that
 * `assertValidLiveThingIdentifier` would otherwise reject for a user.
 */
function namespaceTagGroups(id: string, primitive: Primitive): Primitive {
  const kind = (primitive as unknown as { kind: 'ephemeral' | 'persistent' }).kind;
  const groups = (primitive as unknown as { groups: { name: string }[] }).groups;
  const namespaced = groups.map((g) => ({ ...g, name: pluginWireName(id, g.name) }));
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    groups: namespaced,
    __setup(engine: EngineAccess) {
      engine.registerTagGroups(kind, namespaced as never);
    },
  } as unknown as Primitive;
}

/**
 * Namespace a plugin's error definitions so each code becomes `__<id>::<code>`.
 * The prefixed codes surface in the client's top-level `errors` map.
 */
function namespaceErrors(id: string, primitive: Primitive): Primitive {
  const defs = (primitive as unknown as { defs: ErrorDefWithFactory<string, any>[] }).defs;
  const namespaced = defs.map((def) => namespaceError(pluginWireName(id, def.code), def));
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    defs: namespaced,
    __setup(engine: EngineAccess) {
      engine.registerErrorDefinitions(namespaced as never);
    },
  } as unknown as Primitive;
}

/**
 * Namespace a plugin's channel: the static name / family key and every child
 * event inside its `primitives` list (incoming/request/stream/outgoing). The
 * channel and its events carry the provenance marker so the compile
 * reserved-name and `::` guards permit the framework-namespaced form.
 */
function namespaceChannel(scope: PluginScope, primitive: Primitive): Primitive {
  const { id } = scope;
  const channel = primitive as unknown as {
    pattern: string | ScopeDeclaration<string>;
    primitives: readonly Primitive[];
    __identity: readonly unknown[];
  };
  const [key] = primitive.__identity;

  let pattern: string | ScopeDeclaration<string>;
  let identityTail: string;
  if (typeof channel.pattern === 'string') {
    pattern = pluginWireName(id, channel.pattern);
    identityTail = pattern;
  } else {
    const wireKey = pluginWireName(id, channel.pattern.key);
    pattern = { ...channel.pattern, key: wireKey };
    identityTail = wireKey;
  }

  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    pattern,
    __identity: [key, identityTail],
    __plugin: id,
    // A channel intercept/outgoing hook routes through the same ctx-scope path
    // as a top-level one, so it can emit the channel's namespaced events and
    // throw its declared errors.
    primitives: channel.primitives.map((child) => {
      if (child.__livething === 'intercept') return ownHook(scope, child);

      if (child.__livething === 'outgoingHook') return ownOutgoingHook(scope, child);

      if (CHANNEL_LIFECYCLE_REGISTER[child.__livething]) return scopeChannelLifecycle(scope, child);

      return namespaceOne(scope, child);
    }),
  } as unknown as Primitive;
}

/**
 * Scope a plugin channel's lifecycle child (`check`/`commit`/`revalidate`/
 * `onSubscribe`/`onUnsubscribe`/`onSessionEnd`) so its body runs against a
 * plugin-scoped ctx — its `ctx.channel.broadcast(...)` and other sends then
 * carry the `__<id>::` prefix and match the channel's namespaced emits. The
 * child's own `__setup` closes over the raw handler, so we rebuild `__setup` to
 * register the scoped handler under the same engine hook.
 */
function scopeChannelLifecycle(scope: PluginScope, primitive: Primitive): Primitive {
  const { id, shortCodes } = scope;
  const register = CHANNEL_LIFECYCLE_REGISTER[primitive.__livething]!;
  const handler = (primitive as unknown as { handler: (ctx: any, ...rest: any[]) => unknown })
    .handler;
  const scoped = scopePluginThrow(id, shortCodes, (ctx: any, ...rest: any[]) =>
    handler(scopePluginContext(id, ctx), ...rest),
  );

  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    handler: scoped,
    __setup(engine: EngineAccess) {
      register(engine, scoped, primitive);
    },
  } as unknown as Primitive;
}

/**
 * Rebuild a plugin's `upgrade` carrier so it registers into the plugin upgrade
 * registry (bound to the plugin id) instead of the app's single builder slot.
 * The handler keeps the raw request — a plugin upgrade never sees app identity.
 */
function namespaceUpgrade(id: string, primitive: Primitive): Primitive {
  const handler = (primitive as unknown as { handler: UpgradeHandler }).handler;
  async function scoped(...args: Parameters<UpgradeHandler>): Promise<UpgradeResult> {
    const [request, helpers] = args;
    const result = await handler(request, scopeUpgradeHelpers(id, helpers));
    if (!result?.tags) return result;

    return {
      ...result,
      tags: result.tags.map((ref) =>
        ref.group.startsWith(`__${id}::`) ? ref : { ...ref, group: pluginWireName(id, ref.group) },
      ),
    };
  }

  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    handler: scoped,
    __setup(engine: EngineAccess) {
      engine.registerPluginUpgrade(id, scoped);
    },
  } as unknown as Primitive;
}
