/* oxlint-disable @typescript-eslint/no-explicit-any */
import { assertValidLiveThingIdentifier, WIRE_LIMITS } from '@livething/core';
import { parsePluginWireName } from '~/plugin-scope.ts';
import { collectReplayClaimedScopes } from '~/replay/compile.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as ServerTypes from '~/server-definition.ts';
import * as EngineCompileUtils from './utils.ts';
import type * as EngineCompileTypes from './types.ts';

type CheckEventsInScopeScopeParameter = {
  outgoing: ReadonlyMap<string, unknown>;
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, EngineCompileTypes.AnyGenerate>;
  resumableStreams?: ReadonlyMap<string, EngineCompileTypes.AnyResumableStream>;
  recordedStreams?: ReadonlyMap<string, EngineCompileTypes.AnyRecordedStream>;
};
type CheckScopeParameter = {
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, unknown>;
  resumableStreams?: ReadonlyMap<string, unknown>;
  recordedStreams?: ReadonlyMap<string, unknown>;
};
type CollectFromScopeScopeParameter = {
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  outgoing: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, EngineCompileTypes.AnyGenerate>;
  resumableStreams?: ReadonlyMap<string, EngineCompileTypes.AnyResumableStream>;
  recordedStreams?: ReadonlyMap<string, EngineCompileTypes.AnyRecordedStream>;
};
type CheckScopeScopeParameter = {
  outgoing: ReadonlyMap<string, unknown>;
  incoming: ReadonlyMap<string, unknown>;
  requests: ReadonlyMap<string, unknown>;
  streams: ReadonlyMap<string, EngineCompileTypes.AnyGenerate>;
  resumableStreams?: ReadonlyMap<string, EngineCompileTypes.AnyResumableStream>;
  recordedStreams?: ReadonlyMap<string, EngineCompileTypes.AnyRecordedStream>;
};

/**
 * Walk the top-level primitives into the compiled lookup maps. Returns the
 * channel disjointness validator (carried by any channel primitive seen), or
 * `undefined` when the handler declares no channels — so the core compile step
 * never imports the channel compile code.
 */
function visitCompiledPrimitives(
  compiled: EngineCompileTypes.CompiledServer,
  primitives: readonly PrimitiveCore.Primitive[],
): ((compiled: EngineCompileTypes.CompiledServer) => void) | undefined {
  let validateDisjoint: ((compiled: EngineCompileTypes.CompiledServer) => void) | undefined;

  for (const primitive of primitives) {
    EngineCompileUtils.mergeRequires(compiled.requires, primitive.__requires);

    switch (primitive.__livething) {
      case 'sequence':
        continue;

      case 'replay':
        continue;

      case 'outgoing': {
        const p = primitive as EngineCompileTypes.AnyOutgoing;
        EngineCompileUtils.setUniqueOrThrow(compiled.outgoing, p.event, {
          value: p,
          kind: 'outgoing',
        });
        continue;
      }

      case 'incoming': {
        const p = primitive as EngineCompileTypes.AnyIncoming;
        EngineCompileUtils.setUniqueOrThrow(compiled.incoming, p.event, {
          value: p,
          kind: 'incoming',
        });
        continue;
      }

      case 'request': {
        const p = primitive as EngineCompileTypes.AnyRequest;
        EngineCompileUtils.setUniqueOrThrow(compiled.requests, p.event, {
          value: p,
          kind: 'request',
        });
        continue;
      }

      case 'stream-generate': {
        const p = primitive as EngineCompileTypes.AnyGenerate;
        EngineCompileUtils.setUniqueOrThrow(compiled.streams, p.event, {
          value: p,
          kind: 'stream',
        });
        continue;
      }

      case 'resumable-stream-generate': {
        const p = primitive as EngineCompileTypes.AnyResumableStream;
        EngineCompileUtils.setUniqueOrThrow(compiled.resumableStreams, p.event, {
          value: p,
          kind: 'resumableStream',
        });
        continue;
      }

      case 'recorded-stream-generate': {
        const p = primitive as EngineCompileTypes.AnyRecordedStream;
        EngineCompileUtils.setUniqueOrThrow(compiled.recordedStreams, p.event, {
          value: p,
          kind: 'recordedStream',
        });
        continue;
      }

      case 'scheduled': {
        const p = primitive as EngineCompileTypes.AnyScheduled;
        EngineCompileUtils.setUniqueOrThrow(compiled.scheduled, p.taskId, {
          value: p,
          kind: 'scheduled',
        });
        continue;
      }

      case 'intercept':
        compiled.intercepts.push(primitive as EngineCompileTypes.AnyIntercept);
        continue;
    }

    if (EngineCompileUtils.isChannelPrimitive(primitive)) {
      const compiledChannel = primitive.__compile(primitive);
      validateDisjoint ??= primitive.__validateDisjoint;

      if (typeof primitive.pattern === 'string') {
        if (compiled.channelFamilies.has(primitive.pattern)) {
          throw new Error(
            `[livething] Channel name '${primitive.pattern}' is also registered as a channel family key. ` +
              `Static channel names and family keys must be disjoint — rename one of them.`,
          );
        }

        EngineCompileUtils.setUniqueOrThrow(compiled.channels, primitive.pattern, {
          value: compiledChannel,
          kind: 'channel',
        });
      } else {
        if (compiled.channels.has(primitive.pattern.key)) {
          throw new Error(
            `[livething] Channel family key '${primitive.pattern.key}' is also registered as a static channel name. ` +
              `Static channel names and family keys must be disjoint — rename one of them.`,
          );
        }

        EngineCompileUtils.setUniqueOrThrow(compiled.channelFamilies, primitive.pattern.key, {
          value: compiledChannel,
          kind: 'channel family',
        });
      }

      continue;
    }
  }

  return validateDisjoint;
}

/**
 * Convert the public server definition into the compact structure the engine
 * actually executes.
 */
export function compileServerDefinition(
  definition: ServerTypes.ServerDefinition,
): EngineCompileTypes.CompiledServer {
  const compiled: EngineCompileTypes.CompiledServer = {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    requires: {},
    replayClaimedChannelKeys: new Set<string>(),
    usersPolicy: definition.__usersPolicy,
  };

  const validateChannelsDisjoint = visitCompiledPrimitives(compiled, definition.primitives);
  collectReplayClaimedScopes(definition.primitives, compiled.replayClaimedChannelKeys);
  validateReplayDependencies(definition.primitives);
  validateNoCrossPrimitiveEventCollisions(compiled);
  const declaredPluginEvents = collectPluginEventNames(compiled);

  const declaredPluginChannels = collectPluginChannelNames(compiled);
  validateNoReservedEventNames(compiled, declaredPluginEvents);
  validateScopeAndEventNameSyntax(compiled, declaredPluginEvents, declaredPluginChannels);
  validateChannelsDisjoint?.(compiled);

  return compiled;
}

function hasAnyReplayPrimitive(primitives: readonly PrimitiveCore.Primitive[]): boolean {
  for (const primitive of primitives) {
    if (primitive.__livething === 'replay' && !(primitive as { disabled?: boolean }).disabled) {
      return true;
    }

    if (
      EngineCompileUtils.isChannelPrimitive(primitive) &&
      hasAnyReplayPrimitive(primitive.primitives)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Refuse to boot when replay is enabled but the primitives it relies on are
 * missing or misconfigured. Replay stores every recorded message keyed by
 * a message id (stamped by dedup) and sequence (allocated by sequence). Without
 * dedup the first recorded message cannot be stored safely;
 * without `sequence({ persist: true })` the seq column is unstable across
 * restarts and replay cannot order rows. Fail fast at compile so the misconfig
 * surfaces at boot instead of on the first message. This is the one place the
 * persistent-sequence rule for replay is checked.
 *
 * `replay.custom()` has the same rule: its hooks read `msg.wire.messageId`
 * (from dedup) and `msg.wire.deliverySeq` (from sequence), and a custom store
 * that keeps rows across restarts needs a seq that survives them too.
 */
function validateReplayDependencies(primitives: readonly PrimitiveCore.Primitive[]): void {
  // dedup and sequence are top-level only — they have no meaning nested inside
  // a channel. Replay primitives, however, can appear at the top
  // level OR inside any channel block, so we walk recursively to
  // catch nested cases that the top-level scan would miss.
  let hasDedup = false;
  let hasPersistentSequence = false;
  let hasCustomReplay = false;
  for (const primitive of primitives) {
    if (primitive.__livething === 'dedup') hasDedup = true;
    if (primitive.__livething === 'sequence' && (primitive as { persist?: boolean }).persist) {
      hasPersistentSequence = true;
    }

    if (primitive.__livething === 'replayCustomSend') hasCustomReplay = true;
  }

  if (hasCustomReplay) {
    if (!hasDedup) {
      throw new Error(
        `[livething] replay.custom() needs the dedup() capability. Custom replay hooks get every broadcast's msg.wire.messageId from dedup. List dedup() in server({ capabilities: [...] }).`,
      );
    }

    if (!hasPersistentSequence) {
      throw new Error(
        `[livething] replay.custom() needs a persistent sequence. Custom replay hooks get every broadcast's msg.wire.deliverySeq from sequence, and a stored seq only stays valid across restarts when sequence persists. List sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().`,
      );
    }
  }

  const hasReplay = hasAnyReplayPrimitive(primitives);
  if (!hasReplay) return;

  if (!hasDedup) {
    throw new Error(
      `[livething] replay needs the dedup() capability. Replay stores every recorded message by the message id that dedup stamps. List dedup() in server({ capabilities: [...] }).`,
    );
  }

  if (!hasPersistentSequence) {
    throw new Error(
      `[livething] replay needs a persistent sequence. Replay orders stored rows by seq, which only survives restarts when sequence persists. List sequence({ persist: true }) in server({ capabilities: [...] }) instead of sequence().`,
    );
  }
}

/**
 * Refuse to boot when a scope or event name uses characters reserved by the
 * `contract.matches(...)` / `contract.unsafeCast(...)` path key grammar.
 *
 * Path keys take the form `[<@channel>::]event`, so:
 * - Channel names starting with `@` would be indistinguishable from the scope
 *   prefix.
 * - `::` is the separator between scope name and event name, so neither side
 *   may contain it.
 *
 * These rules are easier to enforce as a build-time hard error than to escape
 * at parse time; real-world names don't need any of these characters.
 */
function validateScopeAndEventNameSyntax(
  compiled: EngineCompileTypes.CompiledServer,
  declaredPluginEvents: ReadonlySet<string>,
  declaredPluginChannels: ReadonlySet<string>,
): void {
  // A static channel name travels on the wire as `channel` (limit 256); a
  // dynamic family key travels as `channelFamily` (limit 128). Validating a
  // family key against the larger channel limit lets a 129-char key boot that
  // no client can ever address.
  function checkScopeName(name: string, kind: 'channel', limit: number): void {
    // A plugin's channel is framework-namespaced as `__<id>::<name>` — it
    // legitimately carries `__` and `::`. Provenance (not string shape) is what
    // exempts the prefix, so a hand-declared `::` channel still throws. The name
    // the plugin declared follows the same rules as an app channel name.
    if (declaredPluginChannels.has(name)) {
      if (name.length > limit) {
        throw new Error(
          `[livething] ${kind} name '${name}' is ${name.length} characters; the wire protocol limit is ${limit}.`,
        );
      }

      const declared = parsePluginWireName(name);
      if (declared) checkDeclaredScopeName(declared.name, kind);

      return;
    }

    assertValidLiveThingIdentifier(name, `${kind} name`, limit);
    checkDeclaredScopeName(name, kind);
  }

  function checkDeclaredScopeName(name: string, kind: 'channel'): void {
    assertValidLiveThingIdentifier(name, `${kind} name`);

    if (name.startsWith('@') || name.startsWith('#')) {
      throw new Error(
        `[livething] ${kind} name '${name}' starts with a reserved prefix character ('@' or '#'). ` +
          `Those prefixes are reserved for the contract.matches(...) path key syntax — pick a different name.`,
      );
    }

    if (name.includes('::')) {
      throw new Error(
        `[livething] ${kind} name '${name}' contains '::', which is reserved as the separator in ` +
          `the contract.matches(...) path key syntax — pick a different name.`,
      );
    }
  }

  function checkEventName(event: string, scopeLabel: string): void {
    // A namespaced plugin event travels as `__<id>::<name>`, where `::` is the
    // intentional id↔name boundary. Exempt that boundary only when it is a known
    // plugin event (by provenance), so a hand-declared `::` name still throws —
    // and so does a `::` inside the name the plugin declared.
    const declared = declaredPluginEvents.has(event) ? parsePluginWireName(event) : null;
    const declaredName = declared ? declared.name : event;
    if (declaredName.includes('::')) {
      const where = declared ? `plugin '${declared.id}' (${scopeLabel})` : scopeLabel;
      throw new Error(
        `[livething] Event name '${declaredName}' in ${where} contains '::', which is reserved as the ` +
          `separator in plugin names and the contract.matches(...) path key syntax — pick a different name.`,
      );
    }

    if (event.length > WIRE_LIMITS.event) {
      throw new Error(
        `[livething] Event name in ${scopeLabel} is ${event.length} characters; the wire protocol limit ` +
          `is ${WIRE_LIMITS.event}. A longer name can't travel over the wire, so no client could reach it.`,
      );
    }
  }

  function checkEventsInScope(scope: CheckEventsInScopeScopeParameter, scopeLabel: string): void {
    for (const event of scope.outgoing.keys()) checkEventName(event, scopeLabel);
    for (const event of scope.incoming.keys()) checkEventName(event, scopeLabel);
    for (const event of scope.requests.keys()) checkEventName(event, scopeLabel);

    for (const [event, generate] of scope.streams) {
      checkEventName(event, scopeLabel);
      // Nudges travel as their own user-event frames, so a nudge name too long
      // for the wire can't be reached either — validate it like any event name.
      for (const nudge of generate.stream.nudges) checkEventName(nudge.event, scopeLabel);
    }

    if (scope.resumableStreams) {
      for (const [event, generate] of scope.resumableStreams) {
        checkEventName(event, scopeLabel);
        for (const nudge of generate.nudges) checkEventName(nudge.event, scopeLabel);
      }
    }

    if (scope.recordedStreams) {
      for (const [event, generate] of scope.recordedStreams) {
        checkEventName(event, scopeLabel);
        for (const nudge of generate.nudges) checkEventName(nudge.event, scopeLabel);
      }
    }
  }

  checkEventsInScope(compiled, 'top-level');

  for (const channel of compiled.channels.values()) {
    checkScopeName(channel.key, 'channel', WIRE_LIMITS.channel);
    checkEventsInScope(channel, `channel '${channel.key}'`);
  }

  for (const family of compiled.channelFamilies.values()) {
    checkScopeName(family.key, 'channel', WIRE_LIMITS.channelFamily);
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
  function check(scope: CheckScopeParameter, label: string): void {
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
          `[livething] Event name '${event}' is registered as both '${where[0]}' and '${where[1]}' in ${label}. ` +
            `An event name can only belong to one of incoming/request/stream/resumableStream/recordedStream within a scope — pick a different name.`,
        );
      }
    }
  }

  check(compiled, 'top-level');

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

  // New-model plugins contribute namespaced incoming/request/outgoing/stream
  // primitives that carry a `__plugin` provenance marker. Collecting their wire
  // names here is what lets the reserved-name guards allow the framework-managed
  // `__<id>::name` form while still rejecting any hand-declared reserved name.
  collectFromScope(compiled, names);
  // A plugin's channel carries its own provenance marker; its child events are
  // namespaced too. Collect them so the guards allow the prefixed child names.
  for (const channel of [...compiled.channels.values(), ...compiled.channelFamilies.values()]) {
    if (channel.__plugin) collectFromScope(channel, names);
  }

  return names;
}

/**
 * Collect every plugin-provenance event name in one scope — plain events plus
 * the nudge names a plugin stream declares (those travel as their own frames).
 */
function collectFromScope(scope: CollectFromScopeScopeParameter, names: Set<string>): void {
  for (const map of [scope.incoming, scope.requests, scope.outgoing]) {
    for (const [event, primitive] of map) {
      if ((primitive as { __plugin?: string }).__plugin) names.add(event);
    }
  }

  for (const [event, generate] of scope.streams) {
    if (!(generate as { __plugin?: string }).__plugin) continue;

    names.add(event);
    for (const nudge of generate.stream.nudges) names.add(nudge.event);
  }

  for (const [event, generate] of scope.resumableStreams ?? []) {
    if (!(generate as { __plugin?: string }).__plugin) continue;

    names.add(event);
    for (const nudge of generate.nudges) names.add(nudge.event);
  }

  for (const [event, generate] of scope.recordedStreams ?? []) {
    if (!(generate as { __plugin?: string }).__plugin) continue;

    names.add(event);
    for (const nudge of generate.nudges) names.add(nudge.event);
  }
}

/** The channel names a plugin owns, so the `::`/`@`/`#` guards allow them. */
function collectPluginChannelNames(
  compiled: EngineCompileTypes.CompiledServer,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const channel of [...compiled.channels.values(), ...compiled.channelFamilies.values()]) {
    if (channel.__plugin) names.add(channel.key);
  }

  return names;
}

/**
 * Walk every event name registered on the compiled server and refuse boot
 * if any clash with the LiveThing wire protocol. Also catches the bypass case
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
        `[livething] '${event}' is a reserved keepalive frame name (used by ${scopeLabel}). ` +
          `Pick a different name for your event.`,
      );
    }

    // The double-underscore prefix is reserved for LiveThing protocol events
    // (__subscribe__, __error__, ...) and plugin-owned events. Allow only the
    // names installed plugins actually declared (by provenance, not by string
    // shape) — anything else with the prefix is a user-declared event that would
    // clash with the protocol.
    if (event.startsWith('__') && !declaredPluginEvents.has(event)) {
      throw new Error(
        `[livething] '${event}' starts with a reserved double-underscore prefix (used by ${scopeLabel}). ` +
          `That prefix is reserved for livething protocol and plugin events — pick a different name.`,
      );
    }
  }

  function checkScope(scope: CheckScopeScopeParameter, label: string): void {
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
  for (const channel of compiled.channels.values()) {
    checkScope(channel, `channel '${channel.key}'`);
  }

  for (const family of compiled.channelFamilies.values()) {
    checkScope(family, `channel family '${family.key}'`);
  }
}
