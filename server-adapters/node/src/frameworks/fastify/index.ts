import type { ServerDefinition } from '@livething/server/adapters';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { webSocketTransport } from '../../socket.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import { isNodeWebSocketUpgrade, rawDataToBytes } from '../../upgrade.ts';
import type { NodeAdmin, NodeEndpointOptions, NodeUpgrade } from '../../binding.ts';

/** Route options returned by a Fastify LiveThing endpoint. */
export interface FastifyWebSocketRoute {
  preHandler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  handler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  wsHandler(socket: WebSocket, request: FastifyRequest): void;
}

/**
 * Route options for the POSTs of `http()` and their CORS preflight. It answers
 * in `onRequest`, before Fastify reads the body.
 */
export interface FastifyHttpRoute {
  onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  handler(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

/** One LiveThing definition registered as a Fastify WebSocket route. */
export interface FastifyEndpoint<TAdmin = NodeAdmin> {
  /** The `GET` route a client connects on: a WebSocket upgrade, or the server-sent events stream. */
  connect: FastifyWebSocketRoute;
  /** The `POST` and `OPTIONS` route on the same path, for `http()`. */
  handle: FastifyHttpRoute;
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

      async function serveHttp(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        reply.hijack();
        const served = await lifecycle
          .prepare(request.raw, async (signal) => {
            // A shutdown ends a request a custom transport still holds, such as a poll.
            signal.addEventListener('abort', () => reply.raw.destroy());
            await endpoint.handleNode(request.raw, reply.raw);
            return true;
          })
          // After hijack() Fastify only logs an error, so end the response here.
          .catch((error: unknown) => {
            reply.raw.destroy();
            throw error;
          });
        if (!served) reply.raw.destroy();
      }

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

        // A plain GET goes to the custom transports, then to the server-sent events stream,
        // or gets a 426 when none takes it.
        handler: serveHttp,

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
            connection = upgrade.accept(webSocketTransport(socket));
          } catch {
            closeWebSocket(socket, 1011, '[livething] connection setup failed');
            return;
          }

          socket.on('message', (data, isBinary) => {
            if (isBinary) {
              void connection.binaryMessage(rawDataToBytes(data));
              return;
            }

            void connection.message(typeof data === 'string' ? data : data.toString());
          });
          socket.on('close', (code, reason) => void connection.close(code, reason.toString()));
          socket.on('error', (error) => void connection.error(error));
        },
      };

      return {
        connect: route,
        handle: {
          onRequest: serveHttp,
          // `onRequest` already answered, so Fastify never calls this.
          async handler() {},
        },
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
