/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  compileChannelPrimitive,
  validateChannelFamilyPatternsDisjointFromStaticNames,
} from '~/channel/compile.ts';
import { compileNamespacePrimitive } from '~/namespace/compile.ts';
import { collectReplayClaimedScopes } from '~/replay/compile.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as DefineServer from '~/server-definition.ts';
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

      case 'intercept':
        compiled.intercepts.push(primitive as EngineCompileTypes.AnyIntercept);
        continue;

      case 'plugin':
        compiled.plugins.push(primitive as EngineCompileTypes.AnyPlugin);
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
    intercepts: [],
    namespaces: new Map(),
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    plugins: [],
    requires: {},
    replayClaimedChannelKeys: new Set<string>(),
  };

  visitCompiledPrimitives(compiled, handler.primitives);
  collectReplayClaimedScopes(handler.primitives, compiled.replayClaimedChannelKeys);
  validateNoCrossPrimitiveEventCollisions(compiled);
  validateNoReservedEventNames(compiled, collectPluginEventNames(compiled));
  validateScopeAndEventNameSyntax(compiled);
  validateChannelFamilyPatternsDisjointFromStaticNames(compiled);
  return compiled;
}

/**
 * Refuse to boot when a scope or event name uses characters reserved by the
 * `contract.matches(...)` / `contract.unsafeCast(...)` path key grammar.
 *
 * Path keys take the form `[<@channel | #namespace>::]event`, so:
 * - Scope names (channel + namespace) starting with `@` or `#` would be
 *   indistinguishable from the scope prefix.
 * - `::` is the separator between scope name and event name, so neither side
 *   may contain it.
 *
 * These rules are easier to enforce as a build-time hard error than to escape
 * at parse time; real-world names don't need any of these characters.
 */
function validateScopeAndEventNameSyntax(compiled: EngineCompileTypes.CompiledServer): void {
  function checkScopeName(name: string, kind: 'channel' | 'namespace'): void {
    if (name.startsWith('@') || name.startsWith('#')) {
      throw new Error(
        `[wskit] ${kind} name '${name}' starts with a reserved prefix character ('@' or '#'). ` +
          `Those prefixes are reserved for the contract.matches(...) path key syntax — pick a different name.`,
      );
    }
    if (name.includes('::')) {
      throw new Error(
        `[wskit] ${kind} name '${name}' contains '::', which is reserved as the separator in ` +
          `the contract.matches(...) path key syntax — pick a different name.`,
      );
    }
  }

  function checkEventName(event: string, scopeLabel: string): void {
    if (event.includes('::')) {
      throw new Error(
        `[wskit] Event name '${event}' in ${scopeLabel} contains '::', which is reserved as the ` +
          `separator in the contract.matches(...) path key syntax — pick a different name.`,
      );
    }
  }

  function checkEventsInScope(
    scope: {
      outgoing: ReadonlyMap<string, unknown>;
      incoming: ReadonlyMap<string, unknown>;
      requests: ReadonlyMap<string, unknown>;
      streams: ReadonlyMap<string, EngineCompileTypes.AnyGenerate>;
      resumableStreams?: ReadonlyMap<string, EngineCompileTypes.AnyResumableStream>;
      recordedStreams?: ReadonlyMap<string, EngineCompileTypes.AnyRecordedStream>;
    },
    scopeLabel: string,
  ): void {
    for (const event of scope.outgoing.keys()) checkEventName(event, scopeLabel);
    for (const event of scope.incoming.keys()) checkEventName(event, scopeLabel);
    for (const event of scope.requests.keys()) checkEventName(event, scopeLabel);
    for (const event of scope.streams.keys()) checkEventName(event, scopeLabel);
    if (scope.resumableStreams) {
      for (const event of scope.resumableStreams.keys()) checkEventName(event, scopeLabel);
    }
    if (scope.recordedStreams) {
      for (const event of scope.recordedStreams.keys()) checkEventName(event, scopeLabel);
    }
  }

  checkEventsInScope(compiled, 'top-level');

  for (const namespace of compiled.namespaces.values()) {
    checkScopeName(namespace.name, 'namespace');
    checkEventsInScope(namespace, `namespace '${namespace.name}'`);
  }

  for (const channel of compiled.channels.values()) {
    checkScopeName(channel.key, 'channel');
    checkEventsInScope(channel, `channel '${channel.key}'`);
  }

  for (const family of compiled.channelFamilies.values()) {
    checkScopeName(family.key, 'channel');
    checkEventsInScope(family, `channel family '${family.key}'`);
  }
}

/**
 * Refuse to boot when an event name is registered as more than one of
 * `incoming` / `request` / `stream` / `resumableStream` / `recordedStream`
 * within the same scope. The dispatcher picks the first match in that order,
 * so the loser is unreachable — a client `request(...)` against a shadowed
 * name hangs forever, and a stream trigger against a recorded-stream name
 * shadowed by an incoming handler never starts a stream.
 *
 * The boot-time guard here covers the bypass case: hand-rolled primitives
 * that go through `as any` and skip the builder.
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
            `An event name can only belong to one of incoming/request/stream/resumableStream/recordedStream within a scope — pick a different name.`,
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
// plugins actually declared. Used by the reserved-name guard to allow those
// exact names through while still rejecting any user-declared double-
// underscore events.
function collectPluginEventNames(compiled: EngineCompileTypes.CompiledServer): ReadonlySet<string> {
  const names = new Set<string>();
  for (const pluginInstance of compiled.plugins) {
    for (const eventName of Object.keys(pluginInstance.outgoing)) {
      names.add(EngineCompileUtils.prefixedPluginEvent(pluginInstance.id, eventName));
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
  declaredPluginEvents: ReadonlySet<string>,
): void {
  function check(event: string, scopeLabel: string): void {
    if (event === 'ping' || event === 'pong') {
      throw new Error(
        `[wskit] '${event}' is a reserved heartbeat frame name (used by ${scopeLabel}). ` +
          `Pick a different name for your event.`,
      );
    }
    // The double-underscore prefix is reserved for wskit protocol events
    // (__subscribe__, __error__, ...) and plugin-owned events. Allow only the
    // names installed plugins actually declared — anything else with the
    // prefix is a user-declared event that would clash with the protocol.
    if (event.startsWith('__') && !declaredPluginEvents.has(event)) {
      throw new Error(
        `[wskit] '${event}' starts with a reserved double-underscore prefix (used by ${scopeLabel}). ` +
          `That prefix is reserved for wskit protocol and plugin events — pick a different name.`,
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
