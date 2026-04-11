/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as DefineServer from '~/define-server.ts';
import type * as PrimitiveCore from '~/primitive.ts';
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

    if (EngineCompileUtils.isPassivePrimitive(primitive)) {
      visitCompiledPrimitives(compiled, primitive.primitives);
      continue;
    }

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
  return compiled;
}
