import type { ServerDefinition } from '@livething/server/adapters';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { sendWhenOpen } from '../../socket.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import { isNodeWebSocketUpgrade } from '../../upgrade.ts';
import type { NodeAdmin, NodeEndpointOptions, NodeUpgrade } from '../../binding.ts';

/** Route options returned by a Fastify LiveThing endpoint. */
export interface FastifyWebSocketRoute {
  preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  handler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  wsHandler(socket: WebSocket, request: FastifyRequest): void;
}

/** One LiveThing definition registered as a Fastify WebSocket route. */
export interface FastifyEndpoint<TAdmin = NodeAdmin> {
  upgrade: FastifyWebSocketRoute;
  ready(): Promise<void>;
  admin(): Promise<TAdmin>;
}

/** Shared lifecycle for Fastify WebSocket routes. */
export interface FastifySetup {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): FastifyEndpoint<NodeAdmin<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Creates Fastify route bindings without creating or listening on an HTTP server. */
export function setup(): FastifySetup {
  const node = binding();
  const lifecycle = createUpgradeLifecycle();

  return {
    bind(definition, options) {
      const endpoint = node.bind(definition, options);
      const upgrades = new WeakMap<IncomingMessage, NodeUpgrade>();

      const route: FastifyWebSocketRoute = {
        async preHandler(request, reply) {
          if (!isNodeWebSocketUpgrade(request.raw)) return;

          const upgrade = await lifecycle.prepare(request.raw, (signal) =>
            endpoint.prepareNode(request.raw, { signal }),
          );

          if (!upgrade) {
            request.raw.socket.once('error', () => {});
            request.raw.destroy();
            return;
          }

          if (upgrade.type === 'http') {
            for (const [name, value] of upgrade.response.headers) reply.header(name, value);
            await reply.code(upgrade.response.status).send(await upgrade.response.text());
            return;
          }

          upgrades.set(request.raw, upgrade);
        },

        async handler(_request, reply) {
          await reply.code(426).type('text/plain; charset=utf-8').send('Upgrade Required');
        },

        wsHandler(socket, request) {
          const upgrade = upgrades.get(request.raw);
          if (!upgrade) {
            closeWebSocket(socket, 1011, '[livething] upgrade decision was not available');
            return;
          }

          upgrades.delete(request.raw);
          if (upgrade.type !== 'accept') {
            if (upgrade.type === 'http') {
              closeWebSocket(socket, 1011, '[livething] upgrade response was not available');
              return;
            }

            closeWebSocket(socket, upgrade.code, upgrade.reason);
            return;
          }

          let connection;
          try {
            connection = upgrade.accept({
              send: (data) => sendWhenOpen(socket.readyState, () => socket.send(data)),
              close: (code, reason) => socket.close(code, reason),
              bufferedAmount: () => socket.bufferedAmount,
              backpressureSupported: true,
            });
          } catch {
            closeWebSocket(socket, 1011, '[livething] connection setup failed');
            return;
          }

          socket.on('message', (data, isBinary) => {
            if (isBinary) {
              closeWebSocket(socket, 1003, '[livething] binary frames are not supported yet');
              return;
            }

            void connection.message(typeof data === 'string' ? data : data.toString());
          });
          socket.on('close', (code, reason) => void connection.close(code, reason.toString()));
          socket.on('error', (error) => void connection.error(error));
        },
      };

      return {
        upgrade: route,
        ready: endpoint.ready,
        admin: endpoint.admin,
      };
    },

    ready: node.ready,

    shutdown() {
      return lifecycle.shutdown(node.shutdown);
    },
  };
}
