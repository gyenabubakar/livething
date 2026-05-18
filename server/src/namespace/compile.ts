/* oxlint-disable @typescript-eslint/no-explicit-any */
import { intercept as interceptFactory } from '~/intercept/intercept.ts';
import { namespace as namespaceFactory } from '~/namespace/namespace.ts';
import type { BuildDefinitionsFn, HandlerMaps } from '~/_api/handler-maps.ts';
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
