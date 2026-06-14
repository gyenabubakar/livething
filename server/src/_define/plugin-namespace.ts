/* oxlint-disable @typescript-eslint/no-explicit-any */
import { namespaceError } from '@wskit/core';
import { pluginWireName, scopePluginContext } from '~/plugin-scope.ts';
import type { ErrorDefWithFactory } from '@wskit/core';
import type { EngineAccess } from '~/_engine/access.ts';
import type { UpgradeHandler } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';

/** The primitive kinds that route or declare by a plain `event` field. */
const EVENT_KINDS = new Set([
  'incoming',
  'request',
  'outgoing',
  'stream-generate',
  'resumable-stream-generate',
  'recorded-stream-generate',
]);

/** Plugin-contributed lifecycle primitives → the engine registry kind they map to. */
const LIFECYCLE_KINDS: Record<string, PluginLifecycleKind> = {
  onInit: 'init',
  onConnect: 'connect',
  onDisconnect: 'disconnect',
  onShutdown: 'shutdown',
  onError: 'error',
  onValidationError: 'validationError',
};

type PluginLifecycleKind =
  | 'init'
  | 'connect'
  | 'disconnect'
  | 'shutdown'
  | 'error'
  | 'validationError';

/** Rewrite one routable primitive into its namespaced form for plugin `id`. */
function namespaceOne(id: string, primitive: Primitive): Primitive {
  if (!EVENT_KINDS.has(primitive.__wskit)) return primitive;
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
    copy.handler = (ctx: any, payload: any) => handler(scopePluginContext(id, ctx), payload);
  }
  const run = (primitive as { run?: (ctx: any, ...rest: any[]) => unknown }).run;
  if (run) {
    copy.run = (ctx: any, ...rest: any[]) => run(scopePluginContext(id, ctx), ...rest);
  }
  return copy as unknown as Primitive;
}

/**
 * Rebuild a plugin's lifecycle primitive so it registers into the plugin
 * lifecycle registry — kept apart from the app's hooks so the engine can run it
 * in onion order (§25). The handler runs against a plugin-scoped context, so its
 * sends are namespaced like any other plugin send.
 */
function namespaceLifecycle(
  id: string,
  kind: PluginLifecycleKind,
  primitive: Primitive,
): Primitive {
  const handler = (primitive as unknown as { handler: (ctx: any, ...rest: any[]) => unknown })
    .handler;
  function scoped(ctx: any, ...rest: any[]): void | Promise<void> {
    return handler(scopePluginContext(id, ctx), ...rest) as void | Promise<void>;
  }
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    handler: scoped,
    __setup(engine: EngineAccess) {
      engine.registerPluginLifecycle(kind, id, scoped);
    },
  } as unknown as Primitive;
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
  return primitives.map((primitive) => {
    if ((primitive as { __scopedUpgrade?: boolean }).__scopedUpgrade) {
      return namespaceUpgrade(id, primitive);
    }
    const lifecycleKind = LIFECYCLE_KINDS[primitive.__wskit];
    if (lifecycleKind) return namespaceLifecycle(id, lifecycleKind, primitive);
    if (primitive.__wskit === 'scheduled') return namespaceScheduled(id, primitive);
    if (primitive.__wskit === 'channel') return namespaceChannel(id, primitive);
    if (primitive.__wskit === 'tag-groups') return namespaceTagGroups(id, primitive);
    if (primitive.__wskit === 'errors') return namespaceErrors(id, primitive);
    return namespaceOne(id, primitive);
  });
}

/**
 * Namespace a plugin's scheduled task so it registers under `__<id>::<task>` and
 * its body runs in a plugin-scoped context (sends prefixed; `ctx.schedule(...)`
 * resolves to the namespaced id).
 */
function namespaceScheduled(id: string, primitive: Primitive): Primitive {
  const taskId = (primitive as unknown as { taskId: string }).taskId;
  const wireTask = pluginWireName(id, taskId);
  const [key] = primitive.__identity;
  const handler = (primitive as unknown as { handler: (ctx: any, data?: any) => unknown }).handler;
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    taskId: wireTask,
    __identity: [key, wireTask],
    __plugin: id,
    handler: (ctx: any, data?: any) => handler(scopePluginContext(id, ctx), data),
  } as unknown as Primitive;
}

/**
 * Namespace a plugin's tag groups so each group declares under `__<id>::<group>`.
 * The provenance marker lets the engine register `::`-bearing names that
 * `assertValidWSKitIdentifier` would otherwise reject for a user.
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
 * The short codes surface back under `InferClient.plugins[id].errors`.
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
 * channel scope and its events carry the provenance marker so the compile
 * reserved-name and `::` guards permit the framework-namespaced form.
 */
function namespaceChannel(id: string, primitive: Primitive): Primitive {
  const channel = primitive as unknown as {
    pattern: string | { key: string; pattern: string };
    primitives: readonly Primitive[];
    __identity: readonly unknown[];
  };
  const [key] = primitive.__identity;

  let pattern: string | { key: string; pattern: string };
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
    primitives: channel.primitives.map((child) => namespaceOne(id, child)),
  } as unknown as Primitive;
}

/**
 * Rebuild a plugin's `upgrade` carrier so it registers into the plugin upgrade
 * registry (bound to the plugin id) instead of the app's single builder slot.
 * The handler keeps the raw request — a plugin upgrade never sees app identity.
 */
function namespaceUpgrade(id: string, primitive: Primitive): Primitive {
  const handler = (primitive as unknown as { handler: UpgradeHandler }).handler;
  return {
    ...(primitive as unknown as Record<PropertyKey, unknown>),
    __plugin: id,
    __setup(engine: EngineAccess) {
      engine.registerPluginUpgrade(id, handler);
    },
  } as unknown as Primitive;
}
