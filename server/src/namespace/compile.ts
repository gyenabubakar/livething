/* oxlint-disable @typescript-eslint/no-explicit-any */
import { addPostIntercept } from '~/intercept/compile.ts';
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { namespace as namespaceFactory } from '~/namespace/namespace.ts';
import type { BuildDefinitionsFn, HandlerMaps } from '~/_api/handler-maps.ts';
import type {
  AnyGenerate,
  AnyIncoming,
  AnyOutgoing,
  AnyPostIntercept,
  AnyPreIntercept,
  AnyRequest,
  CompiledNamespace,
  NamespacePrimitiveType,
} from '~/_engine/compile/types.ts';
import type { NamespaceDef } from '~/namespace/definition.ts';
import type { NamespaceImplement } from '~/namespace/implement.ts';
import type { Primitive } from '~/primitive.ts';

export function compileNamespaceDef(
  def: NamespaceDef,
  namespaceImpls: Map<string, NamespaceImplement<any, any>>,
  buildDefinitions: BuildDefinitionsFn,
): Primitive {
  const impl = namespaceImpls.get(def.name);

  const childHandlers: HandlerMaps = {
    incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
    requestHandlers: impl?._bag.requestHandlers ?? new Map(),
    streamGenerators: impl?._bag.streamGenerators ?? new Map(),
    // Durable streams are top-level only — rejected at build time.
    resumableStreamGenerators: new Map(),
    recordedStreamGenerators: new Map(),
    scheduledHandlers: new Map(),
    channelImpls: impl?._bag.channelImpls ?? new Map(),
    namespaceImpls: new Map(),
  };
  const childPrimitives = buildDefinitions(def.definitions, childHandlers);

  if (impl?._bag.preIntercept) {
    childPrimitives.unshift(interceptFactory(impl._bag.preIntercept));
  }
  if (impl) {
    for (const [event, handler] of impl._bag.postIntercepts) {
      childPrimitives.push(interceptFactory(event, handler));
    }
  }
  return namespaceFactory(def.name, ...(childPrimitives as any[]));
}

// Engine-side: walk a built namespace primitive and sort its children into
// the per-event lookup maps the runtime needs.
export function compileNamespacePrimitive(primitive: NamespacePrimitiveType): CompiledNamespace {
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
    switch (child.__wskit) {
      case 'outgoing':
        scope.outgoing.set((child as AnyOutgoing).event, child as AnyOutgoing);
        break;
      case 'incoming':
        scope.incoming.set((child as AnyIncoming).event, child as AnyIncoming);
        break;
      case 'request':
        scope.requests.set((child as AnyRequest).event, child as AnyRequest);
        break;
      case 'stream-generate':
        scope.streams.set((child as AnyGenerate).event, child as AnyGenerate);
        break;
      case 'intercept': {
        const intercept = child as AnyPreIntercept | AnyPostIntercept;
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
