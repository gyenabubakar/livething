/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  compileChannelPrimitive,
  validateChannelFamilyPatternsDisjointFromStaticNames,
} from '~/channel/compile.ts';
import { addPostIntercept } from '~/intercept/compile.ts';
import { compileNamespacePrimitive } from '~/namespace/compile.ts';
import { collectReplayClaimedScopes } from '~/replay/compile.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as DefineServer from '~/server-definition.ts';
import { RESERVED_EVENT_NAMES } from './utils.ts';
import * as EngineCompileUtils from './utils.ts';
import type * as EngineCompileTypes from './types.ts';

// Walk the declarative primitive tree and fill the compiled runtime shape.
// Per-kind work lives next to the primitive (channel/compile.ts,
// namespace/compile.ts, intercept/compile.ts); this function dispatches.
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

      case 'stream-generate':
        compiled.streams.set(
          (primitive as EngineCompileTypes.AnyGenerate).event,
          primitive as EngineCompileTypes.AnyGenerate,
        );
        continue;

      case 'resumable-stream-generate':
        compiled.resumableStreams.set(
          (primitive as EngineCompileTypes.AnyResumableStream).event,
          primitive as EngineCompileTypes.AnyResumableStream,
        );
        continue;

      case 'recorded-stream-generate':
        compiled.recordedStreams.set(
          (primitive as EngineCompileTypes.AnyRecordedStream).event,
          primitive as EngineCompileTypes.AnyRecordedStream,
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
      compiled.namespaces.set(primitive.pattern, compileNamespacePrimitive(primitive));
      continue;
    }

    if (EngineCompileUtils.isChannelPrimitive(primitive)) {
      const compiledChannel = compileChannelPrimitive(primitive);

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
    resumableStreams: new Map(),
    recordedStreams: new Map(),
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
      resumableStreams?: ReadonlyMap<string, unknown>;
      recordedStreams?: ReadonlyMap<string, unknown>;
    },
    label: string,
  ): void {
    const resumable = scope.resumableStreams ?? (new Map() as ReadonlyMap<string, unknown>);
    const recorded = scope.recordedStreams ?? (new Map() as ReadonlyMap<string, unknown>);
    const allNames = new Set<string>([
      ...scope.incoming.keys(),
      ...scope.requests.keys(),
      ...scope.streams.keys(),
      ...resumable.keys(),
      ...recorded.keys(),
    ]);
    for (const event of allNames) {
      const where: string[] = [];
      if (scope.incoming.has(event)) where.push('incoming');
      if (scope.requests.has(event)) where.push('request');
      if (scope.streams.has(event)) where.push('stream');
      if (resumable.has(event)) where.push('resumableStream');
      if (recorded.has(event)) where.push('recordedStream');
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

// Build the set of double-underscore outgoing event names the installed
// modules actually declared. Used by the reserved-name guard to allow those
// exact names through while still rejecting any user-declared double-
// underscore events.
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
      resumableStreams?: ReadonlyMap<string, EngineCompileTypes.AnyResumableStream>;
      recordedStreams?: ReadonlyMap<string, EngineCompileTypes.AnyRecordedStream>;
    },
    label: string,
  ): void {
    for (const event of scope.outgoing.keys()) check(event, `${label} outgoing`);
    for (const event of scope.incoming.keys()) check(event, `${label} incoming`);
    for (const event of scope.requests.keys()) check(event, `${label} request`);
    for (const [streamEvent, generate] of scope.streams) {
      check(streamEvent, `${label} stream`);
      // A stream can also declare nudges — client-to-server events that drive
      // the active generator. A nudge name that collides with a protocol
      // event would buffer real protocol frames into the stream's nudge
      // queue while the stream is active. Hand-rolled / `as any` nudges
      // bypass the friendly check on `event(...)`, so the boot-time guard
      // has to walk the actual nudge list too.
      for (const nudge of generate.stream.nudges) {
        check(nudge.event, `${label} stream '${streamEvent}' nudge`);
      }
    }
    if (scope.resumableStreams) {
      for (const [streamEvent, primitive] of scope.resumableStreams) {
        check(streamEvent, `${label} resumableStream`);
        for (const nudge of primitive.nudges) {
          check(nudge.event, `${label} resumableStream '${streamEvent}' nudge`);
        }
      }
    }
    if (scope.recordedStreams) {
      for (const [streamEvent, primitive] of scope.recordedStreams) {
        check(streamEvent, `${label} recordedStream`);
        for (const nudge of primitive.nudges) {
          check(nudge.event, `${label} recordedStream '${streamEvent}' nudge`);
        }
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
 * Check that every post-intercept has a matching `incoming` / `request` /
 * `stream` handler in the same scope. Orphan post-intercepts are never fired
 * at runtime because the dispatcher returns early when no handler matches,
 * so this failure must surface at boot instead of silently doing nothing.
 */
interface HandlerScope {
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, unknown>;
  resumableStreams?: ReadonlyMap<string, unknown>;
  recordedStreams?: ReadonlyMap<string, unknown>;
}

function scopeHasHandler(scope: HandlerScope, event: string): boolean {
  return (
    scope.incoming.has(event) ||
    scope.requests.has(event) ||
    scope.streams.has(event) ||
    (scope.resumableStreams?.has(event) ?? false) ||
    (scope.recordedStreams?.has(event) ?? false)
  );
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
