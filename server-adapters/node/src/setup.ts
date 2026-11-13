import { WebSocketServer } from 'ws';
import type { ServerDefinition } from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { binding } from './binding.ts';
import { resolveCompression, resolveMaxMessageBytes } from './endpoint.ts';
import { createNodeUpgradeHandler } from './upgrade.ts';
import type { NodeAdmin, NodeCompressionOption, NodeEndpointOptions } from './endpoint.ts';
import type { NodeHttpRequest, NodeHttpResponse } from './sse.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

/** Options for one definition bound directly to a Node HTTP upgrade listener. */
export interface NodeServerEndpointOptions extends NodeEndpointOptions {
  webSocketServer?: NodeWebSocketServer;
  /**
   * Turns on permessage-deflate, so messages of at least `threshold` bytes (default 1024) go
   * compressed when the client supports it. Default: off. When you pass your own
   * `webSocketServer`, set `perMessageDeflate` on it instead.
   */
  compression?: NodeCompressionOption;
}

/** One definition bound to a Node HTTP or HTTPS upgrade listener. */
export interface NodeEndpointBinding<TAdmin = NodeAdmin> {
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Serve a plain HTTP request to the endpoint's path, from `node:http` or a `node:http2`
   * compatibility server: the server-sent events stream, its POSTs and their CORS
   * preflight. Without `sse()` in `transports`, it answers 426.
   */
  handle(request: NodeHttpRequest, response: NodeHttpResponse): void;
  ready(): Promise<void>;
  admin(): Promise<TAdmin>;
}

/** Shared lifecycle for Node endpoints bound by one application. */
export interface NodeSetup {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeServerEndpointOptions,
  ): NodeEndpointBinding<NodeAdmin<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Creates direct Node HTTP bindings without creating or listening on a server. */
export function setup(): NodeSetup {
  const node = binding();
  const pendingUpgrades = new Set<Promise<void>>();
  const pendingSockets = new Set<Duplex>();
  const pendingResponses = new Set<NodeHttpResponse>();
  let shutdownPromise: Promise<void> | undefined;

  let shuttingDown = false;

  return {
    bind(definition, options) {
      if (shuttingDown) throw new Error('[livething] Node binding is shutting down');

      if (options.webSocketServer && options.compression !== undefined) {
        throw new Error(
          '[livething] bind() got both webSocketServer and compression. Set perMessageDeflate on your own WebSocketServer instead.',
        );
      }

      const maxPayload = resolveMaxMessageBytes(options.maxMessageBytes, 'The endpoint');
      const perMessageDeflate = resolveCompression(options.compression, 'The endpoint');
      const endpoint = node.bind(definition, options);
      // `ws` refuses a bigger message before LiveThing reads it, and closes with 1009.
      const webSocketServer =
        options.webSocketServer ??
        new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate });
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
        handle(request, response) {
          if (shuttingDown) {
            response.destroy();
            return;
          }

          // An open stream is closed by the engine's shutdown; one still in `authenticate`
          // is destroyed here, like a pending upgrade.
          const task = endpoint.handleNode(request, response).catch(() => {
            response.destroy();
          });
          pendingUpgrades.add(task);
          pendingResponses.add(response);
          void task.finally(() => {
            pendingUpgrades.delete(task);
            pendingResponses.delete(response);
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
        for (const response of pendingResponses) response.destroy();
        shutdownPromise = Promise.all([...pendingUpgrades]).then(() => node.shutdown());
      }

      return shutdownPromise;
    },
  };
}
