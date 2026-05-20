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
  AnyRecordedStream,
  AnyRequest,
  AnyResumableStream,
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
  // Channels and nested namespaces are forbidden inside a namespace. The
  // TypeScript signatures already reject them, but a hand-rolled or `as any`
  // contract could slip one in; catch that at build time with a clear error.
  for (const child of def.definitions as readonly {
    _?: string;
    name?: string;
    pattern?: unknown;
  }[]) {
    if (child?._ === 'channel') {
      const channelLabel =
        typeof child.pattern === 'string'
          ? child.pattern
          : ((child.pattern as { name?: string } | undefined)?.name ?? '<unknown>');
      throw new Error(
        `[wskit] namespace '${def.name}' contains channel '${channelLabel}'. ` +
          `Channels cannot be declared inside namespaces — move the channel to the contract's top-level definitions.`,
      );
    }
    if (child?._ === 'namespace') {
      throw new Error(
        `[wskit] namespace '${def.name}' contains namespace '${child.name ?? '<unknown>'}'. ` +
          `Namespaces cannot be nested — declare both at the contract's top level.`,
      );
    }
  }

  const impl = namespaceImpls.get(def.name);

  const childHandlers: HandlerMaps = {
    incomingHandlers: impl?._bag.incomingHandlers ?? new Map(),
    requestHandlers: impl?._bag.requestHandlers ?? new Map(),
    streamGenerators: impl?._bag.streamGenerators ?? new Map(),
    resumableStreamGenerators: impl?._bag.resumableStreamGenerators ?? new Map(),
    recordedStreamGenerators: impl?._bag.recordedStreamGenerators ?? new Map(),
    scheduledHandlers: new Map(),
    channelImpls: new Map(),
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
    resumableStreams: new Map(),
    recordedStreams: new Map(),
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
      case 'resumable-stream-generate':
        scope.resumableStreams.set(
          (child as AnyResumableStream).event,
          child as AnyResumableStream,
        );
        break;
      case 'recorded-stream-generate':
        scope.recordedStreams.set((child as AnyRecordedStream).event, child as AnyRecordedStream);
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
