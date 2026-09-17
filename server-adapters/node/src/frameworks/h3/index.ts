import { defineWebSocketHandler } from 'h3';
import type { ApiOf, ServerDefinition } from '@wskit/server/adapters';
import type { WebSocketMessage, WebSocketPeer } from 'h3';
import type { IncomingMessage } from 'node:http';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import type { NodeAdmin, NodeConnection, NodeEndpointOptions, NodeUpgrade } from '../../binding.ts';

/** One WSKit definition registered as an H3 and CrossWS WebSocket route. */
export interface H3Endpoint<TApi = unknown> {
  upgrade: ReturnType<typeof defineWebSocketHandler>;
  ready(): Promise<void>;
  admin(): Promise<NodeAdmin<TApi>>;
}

/** Shared lifecycle for H3 and CrossWS WebSocket routes. */
export interface H3Setup {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): H3Endpoint<ApiOf<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Creates H3 route bindings without creating or listening on an HTTP server. */
export function setup(): H3Setup {
  const node = binding();
  const lifecycle = createUpgradeLifecycle();

  return {
    bind(definition, options) {
      const endpoint = node.bind(definition, options);
      const connections = new WeakMap<WebSocketPeer, NodeConnection>();

      const route = defineWebSocketHandler(async (event) => {
        const incoming = getIncomingRequest(event.req);
        if (!incoming) throw new Error('[wskit] H3 did not provide a Node request');

        return {
          async upgrade() {
            const upgrade = await lifecycle.prepare(incoming, (signal) =>
              endpoint.prepareNode(incoming, { signal }),
            );
            if (!upgrade) {
              incoming.socket.once('error', () => {});
              incoming.socket.destroy();
              return;
            }

            if (upgrade.type === 'http') return upgrade.response;

            return { context: { upgrade } };
          },

          open(peer) {
            const upgrade = peer.context.upgrade as NodeUpgrade | undefined;
            if (!upgrade) {
              closeWebSocket(peer, 1011, '[wskit] upgrade decision was not available');
              return;
            }

            if (upgrade.type !== 'accept') {
              if (upgrade.type === 'http') {
                closeWebSocket(peer, 1011, '[wskit] upgrade response was not available');
                return;
              }

              closeWebSocket(peer, upgrade.code, upgrade.reason);
              return;
            }

            try {
              const connection = upgrade.accept({
                send: (data) => peer.send(data),
                close: (code, reason) => peer.close(code, reason),
                bufferedAmount: () => peer.bufferedAmount,
                backpressureSupported: true,
              });
              connections.set(peer, connection);
            } catch {
              closeWebSocket(peer, 1011, '[wskit] connection setup failed');
            }
          },

          message(peer, message: WebSocketMessage) {
            if (typeof message.rawData !== 'string') {
              closeWebSocket(peer, 1003, '[wskit] binary frames are not supported yet');
              return;
            }

            void connections.get(peer)?.message(message.rawData);
          },

          close(peer, details) {
            void connections.get(peer)?.close(details.code ?? 1000, details.reason ?? '');
            connections.delete(peer);
          },

          error(peer, error) {
            void connections.get(peer)?.error(error);
          },
        };
      });

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

function getIncomingRequest(request: Request): IncomingMessage | undefined {
  const runtime = (
    request as Request & {
      runtime?: { node?: { req?: IncomingMessage } };
    }
  ).runtime;

  return runtime?.node?.req;
}
