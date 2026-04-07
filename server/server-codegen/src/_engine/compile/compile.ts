/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ServerDefinition } from '~/define-server.ts';
import type { HibernationPrimitive } from '~/hibernation/index.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayPrimitive } from '~/replay/index.ts';
import {
  isChannelPrimitive,
  isNamespacePrimitive,
  isPassivePrimitive,
  mergeRequires,
} from './utils.ts';
import type {
  AnyGenerate,
  AnyIncoming,
  AnyModule,
  AnyOutgoing,
  AnyPostIntercept,
  AnyPreIntercept,
  AnyRequest,
  AnyScheduled,
  ChannelPrimitive,
  CompiledChannel,
  CompiledNamespace,
  CompiledServer,
  ErrorsPrimitive,
  NamespacePrimitive,
} from './types.ts';

/**
 * Append a post-intercept to the per-event intercept list.
 */
function addPostIntercept(
  event: string,
  primitive: AnyPostIntercept,
  map: Map<string, AnyPostIntercept[]>,
): void {
  const existing = map.get(event) ?? [];
  existing.push(primitive);
  map.set(event, existing);
}

/**
 * Compile a namespace block into fast lookup maps.
 */
function compileNamespace(primitive: NamespacePrimitive): CompiledNamespace {
  const scope: CompiledNamespace = {
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
    if (child.__wskit === 'outgoing') scope.outgoing.set(child.event, child as AnyOutgoing);
    else if (child.__wskit === 'incoming') scope.incoming.set(child.event, child as AnyIncoming);
    else if (child.__wskit === 'request') scope.requests.set(child.event, child as AnyRequest);
    else if (child.__wskit === 'generate') scope.streams.set(child.event, child as AnyGenerate);
    else if (child.__wskit === 'intercept') {
      const intercept = child as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') scope.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, scope.postIntercepts);
    }
  }

  return scope;
}

/**
 * Compile a channel or channel-family block into fast lookup maps.
 */
function compileChannel(primitive: ChannelPrimitive): CompiledChannel {
  const key = typeof primitive.pattern === 'string' ? primitive.pattern : primitive.pattern.key;
  const scope: CompiledChannel = {
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
    if (child.__wskit === 'outgoing') scope.outgoing.set(child.event, child as AnyOutgoing);
    else if (child.__wskit === 'incoming') scope.incoming.set(child.event, child as AnyIncoming);
    else if (child.__wskit === 'request') scope.requests.set(child.event, child as AnyRequest);
    else if (child.__wskit === 'generate') scope.streams.set(child.event, child as AnyGenerate);
    else if (child.__wskit === 'replay') scope.replay = child as ReplayPrimitive<any>;
    else if (child.__wskit === 'intercept') {
      const intercept = child as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') scope.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, scope.postIntercepts);
    }
  }

  return scope;
}

/**
 * Walk the declarative primitive tree and fill the compiled runtime shape.
 */
function visitCompiledPrimitives(compiled: CompiledServer, primitives: readonly Primitive[]): void {
  for (const primitive of primitives) {
    mergeRequires(compiled.requires, primitive.__requires);

    if (isPassivePrimitive(primitive)) {
      visitCompiledPrimitives(compiled, primitive.primitives);
      continue;
    }

    if (primitive.__wskit === 'ack') compiled.ack = true;
    else if (primitive.__wskit === 'replay') compiled.replay = primitive as ReplayPrimitive<any>;
    else if (primitive.__wskit === 'heartbeat')
      compiled.heartbeatTimeout = (primitive as any).timeout;
    else if (primitive.__wskit === 'hibernation') {
      compiled.hibernationEnabled = (primitive as HibernationPrimitive).enabled;
    } else if (primitive.__wskit === 'outgoing') {
      compiled.outgoing.set((primitive as AnyOutgoing).event, primitive as AnyOutgoing);
    } else if (primitive.__wskit === 'incoming') {
      compiled.incoming.set((primitive as AnyIncoming).event, primitive as AnyIncoming);
    } else if (primitive.__wskit === 'request') {
      compiled.requests.set((primitive as AnyRequest).event, primitive as AnyRequest);
    } else if (primitive.__wskit === 'generate') {
      compiled.streams.set((primitive as AnyGenerate).event, primitive as AnyGenerate);
    } else if (primitive.__wskit === 'scheduled') {
      compiled.scheduled.set((primitive as AnyScheduled).taskId, primitive as AnyScheduled);
    } else if (primitive.__wskit === 'intercept') {
      const intercept = primitive as AnyPreIntercept | AnyPostIntercept;
      if (intercept.mode === 'pre') compiled.preIntercepts.push(intercept);
      else addPostIntercept(intercept.event, intercept, compiled.postIntercepts);
    } else if (primitive.__wskit === 'errors') {
      compiled.errors.push(primitive as ErrorsPrimitive<any>);
    } else if (primitive.__wskit === 'module') {
      compiled.modules.push(primitive as AnyModule);
    } else if (isNamespacePrimitive(primitive)) {
      compiled.namespaces.set(primitive.pattern, compileNamespace(primitive));
    } else if (isChannelPrimitive(primitive)) {
      const compiledChannel = compileChannel(primitive);
      if (typeof primitive.pattern === 'string')
        compiled.channels.set(primitive.pattern, compiledChannel);
      else compiled.channelFamilies.set(primitive.pattern.key, compiledChannel);
    }
  }
}

/**
 * Convert the public server definition into the compact structure the engine
 * actually executes.
 */
export function compileHandlerDefinition(handler: ServerDefinition): CompiledServer {
  const compiled: CompiledServer = {
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
    errors: [],
    ack: false,
    hibernationEnabled: false,
    requires: {},
  };

  visitCompiledPrimitives(compiled, handler.primitives);
  return compiled;
}
