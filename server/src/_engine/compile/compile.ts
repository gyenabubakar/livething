/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { RESERVED_EVENT_NAMES } from './utils.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as DefineServer from '~/server-definition.ts';
import * as EngineCompileUtils from './utils.ts';
import type * as EngineCompileTypes from './types.ts';

/**
 * Append a post-intercept to the per-event intercept list.
 */
function addPostIntercept(
  event: string,
  primitive: EngineCompileTypes.AnyPostIntercept,
  map: Map<string, EngineCompileTypes.AnyPostIntercept[]>,
): void {
  const existing = map.get(event) ?? [];
  existing.push(primitive);
  map.set(event, existing);
}

/**
 * Compile a namespace block into fast lookup maps.
 */
function compileNamespace(
  primitive: EngineCompileTypes.NamespacePrimitiveType,
): EngineCompileTypes.CompiledNamespace {
  const scope: EngineCompileTypes.CompiledNamespace = {
    kind: 'namespace',
    name: primitive.pattern,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
  };

  for (const child of primitive.primitives) {
    switch (child.__wskit) {
      case 'outgoing':
        scope.outgoing.set(child.event, child as EngineCompileTypes.AnyOutgoing);
        break;
      case 'incoming':
        scope.incoming.set(child.event, child as EngineCompileTypes.AnyIncoming);
        break;
      case 'request':
        scope.requests.set(child.event, child as EngineCompileTypes.AnyRequest);
        break;
      case 'generate':
        scope.streams.set(child.event, child as EngineCompileTypes.AnyGenerate);
        break;
      case 'intercept': {
        const intercept = child as
          | EngineCompileTypes.AnyPreIntercept
          | EngineCompileTypes.AnyPostIntercept;

        if (intercept.mode === 'pre') {
          scope.preIntercepts.push(intercept);
        } else {
          addPostIntercept(intercept.event, intercept, scope.postIntercepts);
        }

        break;
      }
    }
  }

  return scope;
}

/**
 * Compile a channel or channel-family block into fast lookup maps.
 */
function compileChannel(
  primitive: EngineCompileTypes.ChannelPrimitiveType,
): EngineCompileTypes.CompiledChannel {
  const key = typeof primitive.pattern === 'string' ? primitive.pattern : primitive.pattern.key;
  const scope: EngineCompileTypes.CompiledChannel = {
    kind: 'channel',
    key,
    pattern: primitive.pattern,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
  };

  for (const child of primitive.primitives) {
    switch (child.__wskit) {
      case 'outgoing':
        scope.outgoing.set(child.event, child as EngineCompileTypes.AnyOutgoing);
        break;
      case 'incoming':
        scope.incoming.set(child.event, child as EngineCompileTypes.AnyIncoming);
        break;
      case 'request':
        scope.requests.set(child.event, child as EngineCompileTypes.AnyRequest);
        break;
      case 'generate':
        scope.streams.set(child.event, child as EngineCompileTypes.AnyGenerate);
        break;
      case 'intercept': {
        const intercept = child as
          | EngineCompileTypes.AnyPreIntercept
          | EngineCompileTypes.AnyPostIntercept;

        if (intercept.mode === 'pre') {
          scope.preIntercepts.push(intercept);
        } else {
          addPostIntercept(intercept.event, intercept, scope.postIntercepts);
        }

        break;
      }
    }
  }

  return scope;
}

/**
 * Walk the declarative primitive tree and fill the compiled runtime shape.
 */
function visitCompiledPrimitives(
  compiled: EngineCompileTypes.CompiledServer,
  primitives: readonly PrimitiveCore.Primitive[],
): void {
  for (const primitive of primitives) {
    EngineCompileUtils.mergeRequires(compiled.requires, primitive.__requires);

    switch (primitive.__wskit) {
      case 'ack':
        continue;

      case 'sequence':
        continue;

      case 'replay':
        continue;

      case 'outgoing':
        compiled.outgoing.set(
          (primitive as EngineCompileTypes.AnyOutgoing).event,
          primitive as EngineCompileTypes.AnyOutgoing,
        );
        continue;

      case 'incoming':
        compiled.incoming.set(
          (primitive as EngineCompileTypes.AnyIncoming).event,
          primitive as EngineCompileTypes.AnyIncoming,
        );
        continue;

      case 'request':
        compiled.requests.set(
          (primitive as EngineCompileTypes.AnyRequest).event,
          primitive as EngineCompileTypes.AnyRequest,
        );
        continue;

      case 'generate':
        compiled.streams.set(
          (primitive as EngineCompileTypes.AnyGenerate).event,
          primitive as EngineCompileTypes.AnyGenerate,
        );
        continue;

      case 'scheduled':
        compiled.scheduled.set(
          (primitive as EngineCompileTypes.AnyScheduled).taskId,
          primitive as EngineCompileTypes.AnyScheduled,
        );
        continue;

      case 'intercept': {
        const intercept = primitive as
          | EngineCompileTypes.AnyPreIntercept
          | EngineCompileTypes.AnyPostIntercept;
        if (intercept.mode === 'pre') compiled.preIntercepts.push(intercept);
        else addPostIntercept(intercept.event, intercept, compiled.postIntercepts);
        continue;
      }

      case 'module':
        compiled.modules.push(primitive as EngineCompileTypes.AnyModule);
        continue;
    }

    if (EngineCompileUtils.isNamespacePrimitive(primitive)) {
      compiled.namespaces.set(primitive.pattern, compileNamespace(primitive));
      continue;
    }

    if (EngineCompileUtils.isChannelPrimitive(primitive)) {
      const compiledChannel = compileChannel(primitive);

      if (typeof primitive.pattern === 'string') {
        if (compiled.channelFamilies.has(primitive.pattern)) {
          throw new Error(
            `[wskit] Channel name '${primitive.pattern}' is also registered as a channel family key. ` +
              `Static channel names and family keys must be disjoint — rename one of them.`,
          );
        }
        compiled.channels.set(primitive.pattern, compiledChannel);
      } else {
        if (compiled.channels.has(primitive.pattern.key)) {
          throw new Error(
            `[wskit] Channel family key '${primitive.pattern.key}' is also registered as a static channel name. ` +
              `Static channel names and family keys must be disjoint — rename one of them.`,
          );
        }
        compiled.channelFamilies.set(primitive.pattern.key, compiledChannel);
      }

      continue;
    }
  }
}

/**
 * Convert the public server definition into the compact structure the engine
 * actually executes.
 */
export function compileHandlerDefinition(
  handler: DefineServer.ServerDefinition,
): EngineCompileTypes.CompiledServer {
  const compiled: EngineCompileTypes.CompiledServer = {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
    namespaces: new Map(),
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    modules: [],
    requires: {},
    replayClaimedChannelKeys: new Set<string>(),
  };

  visitCompiledPrimitives(compiled, handler.primitives);
  collectReplayClaimedScopes(handler.primitives, compiled.replayClaimedChannelKeys);
  validatePostInterceptHandlers(compiled);
  validateNoCrossPrimitiveEventCollisions(compiled);
  validateNoReservedEventNames(compiled, collectModuleEventNames(compiled));
  validateChannelFamilyPatternsDisjointFromStaticNames(compiled);
  return compiled;
}

/**
 * Refuse to boot when an event name is registered as more than one of
 * `incoming` / `request` / `stream` within the same scope. The dispatcher
 * picks the first match in that order, so the loser is unreachable —
 * a client `request(...)` against a shadowed name hangs forever.
 *
 * The builder's `validateNoCrossPrimitiveEventCollisions` already catches
 * this. The boot-time guard here covers the bypass case: hand-rolled
 * primitives that go through `as any` and skip the builder.
 */
function validateNoCrossPrimitiveEventCollisions(
  compiled: EngineCompileTypes.CompiledServer,
): void {
  function check(
    scope: {
      incoming: ReadonlyMap<string, unknown>;
      requests: ReadonlyMap<string, unknown>;
      streams: ReadonlyMap<string, unknown>;
    },
    label: string,
  ): void {
    const allNames = new Set<string>([
      ...scope.incoming.keys(),
      ...scope.requests.keys(),
      ...scope.streams.keys(),
    ]);
    for (const event of allNames) {
      const where: string[] = [];
      if (scope.incoming.has(event)) where.push('incoming');
      if (scope.requests.has(event)) where.push('request');
      if (scope.streams.has(event)) where.push('stream');
      if (where.length > 1) {
        throw new Error(
          `[wskit] Event name '${event}' is registered as both '${where[0]}' and '${where[1]}' in ${label}. ` +
            `An event name can only be used by one of incoming/request/stream within a scope — pick a different name.`,
        );
      }
    }
  }

  check(compiled, 'top-level');
  for (const namespace of compiled.namespaces.values()) {
    check(namespace, `namespace '${namespace.name}'`);
  }
  for (const channel of compiled.channels.values()) {
    check(channel, `channel '${channel.key}'`);
  }
  for (const family of compiled.channelFamilies.values()) {
    check(family, `channel family '${family.key}'`);
  }
}

/**
 * Build the set of double-underscore outgoing event names the installed
 * modules actually declared. Used by the reserved-name guard to allow
 * those exact names through while still rejecting any user-declared
 * double-underscore events.
 */
function collectModuleEventNames(compiled: EngineCompileTypes.CompiledServer): ReadonlySet<string> {
  const names = new Set<string>();
  for (const moduleInstance of compiled.modules) {
    for (const eventName of Object.keys(moduleInstance.outgoing)) {
      names.add(EngineCompileUtils.prefixedModuleEvent(moduleInstance.id, eventName));
    }
  }
  return names;
}

/**
 * Refuse to boot when any registered channel family's pattern matches a
 * registered static channel name. The two would route the same wire
 * `_channel` value to different compiled definitions depending on which side
 * the lookup hit first; surfacing the conflict at boot time keeps the runtime
 * behavior unambiguous.
 */
function validateChannelFamilyPatternsDisjointFromStaticNames(
  compiled: EngineCompileTypes.CompiledServer,
): void {
  for (const [familyKey, family] of compiled.channelFamilies) {
    for (const staticName of compiled.channels.keys()) {
      if (ChannelPrimitive.matchesScopePattern(family.pattern, staticName)) {
        throw new Error(
          `[wskit] Channel family '${familyKey}' has a pattern that matches the static ` +
            `channel name '${staticName}'. Static channel names and family patterns must be ` +
            `disjoint — narrow the family pattern or rename the static channel.`,
        );
      }
    }
  }
}

/**
 * Walk every event name registered on the compiled server and refuse boot
 * if any clash with the wskit wire protocol. Also catches the bypass case
 * where a developer hand-rolls an event-shaped object instead of calling
 * `event(name, schema)` — the runtime guard sees the same primitives.
 */
function validateNoReservedEventNames(
  compiled: EngineCompileTypes.CompiledServer,
  declaredModuleEvents: ReadonlySet<string>,
): void {
  function check(event: string, scopeLabel: string): void {
    if (RESERVED_EVENT_NAMES.has(event)) {
      throw new Error(
        `[wskit] '${event}' is a reserved protocol event name (used by ${scopeLabel}). ` +
          `Pick a different name for your event.`,
      );
    }
    // Catch hand-rolled / `as any` events that bypass the friendly check
    // in `event(...)`. The double-underscore prefix is reserved for module-
    // owned outgoing events; allow only the names the modules themselves
    // declared. Anything else with the prefix is a user-declared event
    // that would silently fail at send time.
    if (event.startsWith('__')) {
      if (!declaredModuleEvents.has(event)) {
        throw new Error(
          `[wskit] '${event}' starts with a reserved double-underscore prefix (used by ${scopeLabel}). ` +
            `That prefix is reserved for module-owned outgoing events — pick a different name.`,
        );
      }
      return;
    }
    // The single-underscore prefix is reserved for engine protocol events
    // as a name-shape rule, so the framework can add new protocol events
    // later without breaking user handlers.
    if (event.startsWith('_')) {
      throw new Error(
        `[wskit] '${event}' starts with a reserved single-underscore prefix (used by ${scopeLabel}). ` +
          `That prefix is reserved for engine protocol events — pick a different name.`,
      );
    }
  }

  function checkScope(
    scope: {
      outgoing: ReadonlyMap<string, unknown>;
      incoming: ReadonlyMap<string, unknown>;
      requests: ReadonlyMap<string, unknown>;
      streams: ReadonlyMap<string, EngineCompileTypes.AnyGenerate>;
    },
    label: string,
  ): void {
    for (const event of scope.outgoing.keys()) check(event, `${label} outgoing`);
    for (const event of scope.incoming.keys()) check(event, `${label} incoming`);
    for (const event of scope.requests.keys()) check(event, `${label} request`);
    for (const [streamEvent, generate] of scope.streams) {
      check(streamEvent, `${label} stream`);
      // A stream can also declare nudges — client-to-server events that drive
      // the active generator. A nudge name that collides with a protocol event
      // would buffer real protocol frames into the stream's nudge queue while
      // the stream is active. Hand-rolled / `as any` nudges bypass the
      // friendly check on `event(...)`, so the boot-time guard has to walk
      // the actual nudge list too.
      for (const nudge of generate.stream.nudges) {
        check(nudge.event, `${label} stream '${streamEvent}' nudge`);
      }
    }
  }

  checkScope(compiled, 'top-level');
  for (const namespace of compiled.namespaces.values()) {
    checkScope(namespace, `namespace '${namespace.name}'`);
  }
  for (const channel of compiled.channels.values()) {
    checkScope(channel, `channel '${channel.key}'`);
  }
  for (const family of compiled.channelFamilies.values()) {
    checkScope(family, `channel family '${family.key}'`);
  }
}

/**
 * Walk the primitive tree and record every channel key that has its own
 * `.replay(...)` (configured or `replay(false)` disabled). Server-level replay
 * uses the resulting set to skip channels that opted out of cascade.
 *
 * Groups merge into the parent scope, so we descend into them with the parent
 * channel key. Namespaces don't currently support replay; we still descend in
 * case future code adds it.
 */
function collectReplayClaimedScopes(
  primitives: readonly PrimitiveCore.Primitive[],
  out: Set<string>,
  parentChannelKey?: string,
): void {
  for (const primitive of primitives) {
    if (primitive.__wskit === 'replay' || primitive.__wskit === 'replayCustom') {
      if (parentChannelKey) out.add(parentChannelKey);
      continue;
    }

    if (primitive.__wskit === 'group') {
      const group = primitive as PrimitiveCore.Primitive & {
        primitives: readonly PrimitiveCore.Primitive[];
      };
      collectReplayClaimedScopes(group.primitives, out, parentChannelKey);
      continue;
    }

    if (primitive.__wskit === 'channel') {
      const channelPrimitive = primitive as PrimitiveCore.Primitive & {
        pattern: string | { key: string };
        primitives: readonly PrimitiveCore.Primitive[];
      };
      const channelKey =
        typeof channelPrimitive.pattern === 'string'
          ? channelPrimitive.pattern
          : channelPrimitive.pattern.key;
      collectReplayClaimedScopes(channelPrimitive.primitives, out, channelKey);
      continue;
    }

    if (primitive.__wskit === 'namespace') {
      const namespacePrimitive = primitive as PrimitiveCore.Primitive & {
        primitives: readonly PrimitiveCore.Primitive[];
      };
      collectReplayClaimedScopes(namespacePrimitive.primitives, out, parentChannelKey);
      continue;
    }
  }
}

/**
 * Check that every post-intercept has a matching `incoming`/`request`/`stream`
 * handler in the same scope. Orphan post-intercepts are never fired at runtime
 * because the dispatcher returns early when no handler matches, so this failure
 * must surface at boot instead of silently doing nothing.
 */
interface HandlerScope {
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, unknown>;
}

function scopeHasHandler(scope: HandlerScope, event: string): boolean {
  return scope.incoming.has(event) || scope.requests.has(event) || scope.streams.has(event);
}

function assertPostInterceptHandlerExists(
  scope: HandlerScope,
  event: string,
  scopeLabel: string,
): void {
  if (scopeHasHandler(scope, event)) return;
  throw new Error(
    `[wskit] Post-intercept registered for '${event}' in ${scopeLabel} but no incoming/request/stream handler accepts '${event}' there. Add a handler or remove the post-intercept.`,
  );
}

function validatePostInterceptHandlers(compiled: EngineCompileTypes.CompiledServer): void {
  for (const event of compiled.postIntercepts.keys()) {
    assertPostInterceptHandlerExists(compiled, event, 'top-level');
  }

  for (const namespace of compiled.namespaces.values()) {
    for (const event of namespace.postIntercepts.keys()) {
      assertPostInterceptHandlerExists(namespace, event, `namespace '${namespace.name}'`);
    }
  }

  for (const channel of compiled.channels.values()) validateChannelPostIntercepts(channel);
  for (const channel of compiled.channelFamilies.values()) validateChannelPostIntercepts(channel);
}

function validateChannelPostIntercepts(channel: EngineCompileTypes.CompiledChannel): void {
  const patternLabel = typeof channel.pattern === 'string' ? channel.pattern : channel.pattern.key;
  for (const event of channel.postIntercepts.keys()) {
    assertPostInterceptHandlerExists(channel, event, `channel '${patternLabel}'`);
  }
}
