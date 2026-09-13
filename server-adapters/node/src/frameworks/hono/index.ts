import { upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type { ApiOf, ServerDefinition } from '@wskit/server/adapters';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import { binding } from '../../binding.ts';
import type { NodeAdmin, NodeConnection, NodeEndpointOptions } from '../../binding.ts';

/** One WSKit definition registered as a Hono WebSocket route. */
export interface HonoEndpoint<TApi = unknown> {
  upgrade: MiddlewareHandler;
  ready(): Promise<void>;
  admin(): Promise<NodeAdmin<TApi>>;
}

/** Shared Hono WebSocket transport and lifecycle. */
export interface HonoSetup {
  readonly websocket: { server: WebSocketServer };
  bind<THandler extends ServerDefinition>(
    handler: THandler,
    options: NodeEndpointOptions,
  ): HonoEndpoint<ApiOf<THandler>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Options for the shared Hono WebSocket transport. */
export interface HonoSetupOptions {
  webSocketServer?: WebSocketServer;
}

/** Creates Hono route bindings without creating or listening on an HTTP server. */
export function setup(setupOptions: HonoSetupOptions = {}): HonoSetup {
  const node = binding();
  const server = setupOptions.webSocketServer ?? new WebSocketServer({ noServer: true });

  return {
    websocket: { server },

    bind(handler, endpointOptions) {
      const endpoint = node.bind(handler, endpointOptions);
      const connections = new WeakMap<object, NodeConnection>();

      async function route(
        context: Parameters<MiddlewareHandler>[0],
        next: Parameters<MiddlewareHandler>[1],
      ) {
        const incoming = getIncomingRequest(context.env);
        if (!incoming)
          return new Response('[wskit] Hono did not provide a Node request', { status: 500 });

        const upgrade = await endpoint.prepareNode(incoming);

        if (upgrade.type === 'http') return upgrade.response;

        return upgradeWebSocket(() => ({
          onOpen(_event, socket) {
            if (upgrade.type === 'socket') {
              socket.close(upgrade.code, upgrade.reason);
              return;
            }

            const connection = upgrade.accept({
              send: (data) => socket.send(data),
              close: (code, reason) => socket.close(code, reason),
              bufferedAmount: () => 0,
              backpressureSupported: false,
            });
            connections.set(socket, connection);
          },
          onMessage(event, socket) {
            if (typeof event.data !== 'string') {
              socket.close(1003, '[wskit] binary frames are not supported yet');
              return;
            }

            void connections.get(socket)?.message(event.data);
          },
          onClose(event, socket) {
            void connections.get(socket)?.close(event.code, event.reason);
            connections.delete(socket);
          },
          onError(event, socket) {
            void connections.get(socket)?.error(event);
            connections.delete(socket);
          },
        }))(context, next);
      }

      return {
        upgrade: route,
        ready: endpoint.ready,
        admin: endpoint.admin,
      };
    },

    ready: node.ready,

    shutdown() {
      return node.shutdown();
    },
  };
}

function getIncomingRequest(environment: unknown): IncomingMessage | undefined {
  return (environment as { incoming?: IncomingMessage }).incoming;
}
