import { WebSocketServer } from 'ws';
import type { ApiOf, ServerDefinition } from '@wskit/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { binding } from './binding.ts';
import { createNodeUpgradeHandler } from './upgrade.ts';
import type { NodeAdmin, NodeEndpointOptions } from './endpoint.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

/** Options for one definition bound directly to a Node HTTP upgrade listener. */
export interface NodeServerEndpointOptions extends NodeEndpointOptions {
  webSocketServer?: NodeWebSocketServer;
}

/** One definition bound to a Node HTTP or HTTPS upgrade listener. */
export interface NodeEndpointBinding<TApi = unknown> {
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  ready(): Promise<void>;
  admin(): Promise<NodeAdmin<TApi>>;
}

/** Shared lifecycle for Node endpoints bound by one application. */
export interface NodeSetup {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeServerEndpointOptions,
  ): NodeEndpointBinding<ApiOf<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Creates direct Node HTTP bindings without creating or listening on a server. */
export function setup(): NodeSetup {
  const node = binding();
  const pendingUpgrades = new Set<Promise<void>>();
  const pendingSockets = new Set<Duplex>();
  let shutdownPromise: Promise<void> | undefined;
  let shuttingDown = false;

  return {
    bind(definition, options) {
      if (shuttingDown) throw new Error('[wskit] Node binding is shutting down');

      const endpoint = node.bind(definition, options);
      const webSocketServer = options.webSocketServer ?? new WebSocketServer({ noServer: true });
      const handleUpgrade = createNodeUpgradeHandler({ endpoint, webSocketServer });

      return {
        upgrade(request, socket, head) {
          if (shuttingDown) {
            socket.destroy();
            return;
          }

          const task = handleUpgrade(request, socket, head).catch(() => {
            socket.destroy();
          });
          pendingUpgrades.add(task);
          pendingSockets.add(socket);
          void task.finally(() => {
            pendingUpgrades.delete(task);
            pendingSockets.delete(socket);
          });
        },
        ready: endpoint.ready,
        admin: endpoint.admin,
      };
    },
    ready: node.ready,
    shutdown() {
      if (!shutdownPromise) {
        shuttingDown = true;
        for (const socket of pendingSockets) socket.destroy();
        shutdownPromise = Promise.all([...pendingUpgrades]).then(() => node.shutdown());
      }

      return shutdownPromise;
    },
  };
}
