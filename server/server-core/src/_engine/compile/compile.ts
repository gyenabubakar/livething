/* oxlint-disable @typescript-eslint/no-explicit-any */
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
        compiled.channels.set(primitive.pattern, compiledChannel);
      } else {
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
  };

  visitCompiledPrimitives(compiled, handler.primitives);
  validatePostInterceptHandlers(compiled);
  return compiled;
}

/**
 * Check that every post-intercept has a matching `incoming`/`request`/`stream`
 * handler in the same scope. Orphan post-intercepts are never fired at runtime
 * because the dispatcher returns early when no handler matches, so this failure
 * must surface at boot instead of silently doing nothing.
 */
function validatePostInterceptHandlers(compiled: EngineCompileTypes.CompiledServer): void {
  function assertHandlerExists(
    event: string,
    scopeLabel: string,
    has: (e: string) => boolean,
  ): void {
    if (has(event)) return;
    throw new Error(
      `[wskit] Post-intercept registered for '${event}' in ${scopeLabel} but no incoming/request/stream handler accepts '${event}' there. Add a handler or remove the post-intercept.`,
    );
  }

  function topHas(event: string): boolean {
    return (
      compiled.incoming.has(event) || compiled.requests.has(event) || compiled.streams.has(event)
    );
  }

  for (const event of compiled.postIntercepts.keys()) {
    assertHandlerExists(event, 'top-level', topHas);
  }

  for (const namespace of compiled.namespaces.values()) {
    function has(event: string): boolean {
      return (
        namespace.incoming.has(event) ||
        namespace.requests.has(event) ||
        namespace.streams.has(event)
      );
    }
    for (const event of namespace.postIntercepts.keys()) {
      assertHandlerExists(event, `namespace '${namespace.name}'`, has);
    }
  }

  function validateChannel(channel: EngineCompileTypes.CompiledChannel): void {
    function has(event: string): boolean {
      return (
        channel.incoming.has(event) || channel.requests.has(event) || channel.streams.has(event)
      );
    }
    const patternLabel =
      typeof channel.pattern === 'string' ? channel.pattern : channel.pattern.key;
    for (const event of channel.postIntercepts.keys()) {
      assertHandlerExists(event, `channel '${patternLabel}'`, has);
    }
  }

  for (const channel of compiled.channels.values()) validateChannel(channel);
  for (const channel of compiled.channelFamilies.values()) validateChannel(channel);
}
