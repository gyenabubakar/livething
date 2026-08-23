import { server } from '@wskit/server-node';
import type { NodeServer, NodeServerOptions } from '@wskit/server-node';
import type { ServerDefinition } from '@wskit/server/adapters';

export type NodeFixtureFactory = (
  options: NodeServerOptions<unknown>,
) => NodeServer<unknown, unknown>;

export function bind(handler: ServerDefinition): NodeFixtureFactory {
  return (options) => server(handler, options) as NodeServer<unknown, unknown>;
}
