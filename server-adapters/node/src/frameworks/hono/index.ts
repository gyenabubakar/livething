import { upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type { ApiOf, ServerDefinition } from '@livething/server/adapters';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import { isNodeWebSocketUpgrade, isWebSocketUpgrade } from '../../upgrade.ts';
import type { NodeAdmin, NodeConnection, NodeEndpointOptions } from '../../binding.ts';

/** One LiveThing definition registered as a Hono WebSocket route. */
export interface HonoEndpoint<TApi = unknown> {
  upgrade: MiddlewareHandler;
  ready(): Promise<void>;
  admin(): Promise<NodeAdmin<TApi>>;
}

/** Shared Hono WebSocket transport and lifecycle. */
export interface HonoSetup {
  readonly websocket: { server: WebSocketServer };
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): HonoEndpoint<ApiOf<TDefinition>>;
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
  const lifecycle = createUpgradeLifecycle();
  const server = setupOptions.webSocketServer ?? new WebSocketServer({ noServer: true });

  return {
    websocket: { server },

    bind(definition, endpointOptions) {
      const endpoint = node.bind(definition, endpointOptions);
      const connections = new WeakMap<object, NodeConnection>();

      async function route(
        context: Parameters<MiddlewareHandler>[0],
        next: Parameters<MiddlewareHandler>[1],
      ) {
        if (!isWebSocketUpgrade(context.req.header('upgrade'))) return next();

        const incoming = getIncomingRequest(context.env);
        if (!incoming)
          return new Response('[livething] Hono did not provide a Node request', { status: 500 });

        if (!isNodeWebSocketUpgrade(incoming)) return next();

        const upgrade = await lifecycle.prepare(incoming, (signal) =>
          endpoint.prepareNode(incoming, { signal }),
        );

        if (!upgrade) {
          incoming.socket.once('error', () => {});
          incoming.socket.destroy();
          return;
        }

        if (upgrade.type === 'http') return upgrade.response;

        return upgradeWebSocket(() => ({
          onOpen(_event, socket) {
            if (upgrade.type === 'socket') {
              closeWebSocket(socket, upgrade.code, upgrade.reason);
              return;
            }

            try {
              const rawSocket = socket.raw as WebSocket;
              const connection = upgrade.accept({
                send: (data) => socket.send(data),
                close: (code, reason) => socket.close(code, reason),
                bufferedAmount: () => rawSocket.bufferedAmount,
                backpressureSupported: true,
              });
              connections.set(socket, connection);
            } catch {
              closeWebSocket(socket, 1011, '[livething] connection setup failed');
            }
          },
          onMessage(event, socket) {
            if (typeof event.data !== 'string') {
              closeWebSocket(socket, 1003, '[livething] binary frames are not supported yet');
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
      return lifecycle.shutdown(node.shutdown);
    },
  };
}

function getIncomingRequest(environment: unknown): IncomingMessage | undefined {
  return (environment as { incoming?: IncomingMessage }).incoming;
}
