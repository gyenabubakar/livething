// The finished hono-binding.ts of the Node adapter page's "Authoring a Node integration" steps.
import { binding } from '@livething/server-node/binding';
import type { NodeEndpointOptions } from '@livething/server-node/binding';
import type { ServerDefinition } from '@livething/server/adapters';

export function setup() {
  const node = binding();

  function bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ) {
    const endpoint = node.bind(definition, options);
    const upgrade = async (context: unknown, next: unknown) => new Response(null, { status: 426 });
    return { upgrade, ready: endpoint.ready, admin: endpoint.admin };
  }

  return { websocket: {}, bind, ready: node.ready, shutdown: node.shutdown };
}
