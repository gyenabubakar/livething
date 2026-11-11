import { asUint8Array } from '@livething/server/adapters';
import type { ServerDefinition } from '@livething/server/adapters';
import type {
  defineWebSocketHandler as H3DefineWebSocketHandler,
  WebSocketMessage,
  WebSocketPeer,
} from 'h3';
import type { IncomingMessage } from 'node:http';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { frameData, sendWhenOpen } from '../../socket.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import { invalidUpgradeResponse, isWebSocketUpgrade } from '../../upgrade.ts';
import { createWebUpgradeLifecycle } from '../../web-upgrade-lifecycle.ts';
import type { NodeAdmin, NodeConnection, NodeEndpointOptions, NodeUpgrade } from '../../binding.ts';

interface H3Event {
  readonly req: Request;
}

interface H3Hooks {
  upgrade(): Promise<Response | { context: { upgrade: NodeUpgrade } } | void>;
  open(peer: WebSocketPeer): void;
  message(peer: WebSocketPeer, message: WebSocketMessage): void;
  close(peer: WebSocketPeer, details: { code?: number; reason?: string }): void;
  error(peer: WebSocketPeer, error: unknown): void;
}

type DefineWebSocketHandler<THandler> = (
  factory: (event: H3Event) => Promise<H3Hooks> | H3Hooks,
) => THandler;

/** One LiveThing definition registered as an H3 and CrossWS WebSocket route. */
export interface H3Endpoint<
  TAdmin = NodeAdmin,
  THandler = ReturnType<typeof H3DefineWebSocketHandler>,
> {
  upgrade: THandler;
  ready(): Promise<void>;
  admin(): Promise<TAdmin>;
}

/** Shared lifecycle for H3 and CrossWS WebSocket routes. */
export interface H3Setup<THandler> {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): H3Endpoint<NodeAdmin<TDefinition>, THandler>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createH3Setup<THandler>(
  defineWebSocketHandler: DefineWebSocketHandler<THandler>,
): H3Setup<THandler> {
  const node = binding();
  const nodeLifecycle = createUpgradeLifecycle();
  const webLifecycle = createWebUpgradeLifecycle();
  let shutdownPromise: Promise<void> | undefined;

  return {
    bind(definition, options) {
      const endpoint = node.bind(definition, options);
      const connections = new WeakMap<WebSocketPeer, NodeConnection>();

      const route = defineWebSocketHandler(async (event) => {
        const incoming = getIncomingRequest(event.req);

        return {
          async upgrade() {
            if (!isWebSocketUpgrade(event.req.headers.get('upgrade'))) {
              return invalidUpgradeResponse();
            }

            let upgrade: NodeUpgrade | undefined;
            if (incoming) {
              upgrade = await nodeLifecycle.prepare(incoming, (signal) =>
                endpoint.prepareNode(incoming, { signal }),
              );
            } else {
              if (options.clientIp !== undefined) {
                throw new Error(
                  '[livething] H3 did not provide a Node request required by clientIp',
                );
              }

              upgrade = await webLifecycle.prepare(
                (signal) => endpoint.prepare(createWebRequest(event.req, signal)),
                event.req.signal,
              );
            }

            if (!upgrade) {
              if (!incoming) return new Response(null, { status: 503 });

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
              closeWebSocket(peer, 1011, '[livething] upgrade decision was not available');
              return;
            }

            if (upgrade.type !== 'accept') {
              if (upgrade.type === 'http') {
                closeWebSocket(peer, 1011, '[livething] upgrade response was not available');
                return;
              }

              closeWebSocket(peer, upgrade.code, upgrade.reason);
              return;
            }

            try {
              const connection = upgrade.accept({
                // CrossWS passes `compress: undefined` to ws unless told, which turns compression off.
                // ws still skips it when permessage-deflate is not negotiated or the frame is small.
                send: (frame) =>
                  sendWhenOpen(peer.websocket.readyState, () =>
                    peer.send(frameData(frame), { compress: true }),
                  ),
                close: (code, reason) => peer.close(code, reason),
                terminate: () => peer.terminate(),
                bufferedAmount: () => peer.bufferedAmount,
                backpressureSupported: true,
              });
              connections.set(peer, connection);
            } catch {
              closeWebSocket(peer, 1011, '[livething] connection setup failed');
            }
          },

          message(peer, message) {
            if (typeof message.rawData !== 'string') {
              // crossws hands a binary message over as a ws Buffer, or an ArrayBuffer.
              const bytes = asUint8Array(message.rawData as Buffer | ArrayBuffer);
              void connections.get(peer)?.binaryMessage(bytes);
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
      if (!shutdownPromise) {
        shutdownPromise = Promise.all([
          nodeLifecycle.shutdown(async () => {}),
          webLifecycle.shutdown(async () => {}),
        ])
          .then(() => node.shutdown())
          .then(() => {});
      }

      return shutdownPromise;
    },
  };
}

function createWebRequest(request: Request, signal: AbortSignal): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal,
  });
}

function getIncomingRequest(request: Request): IncomingMessage | undefined {
  const runtime = (
    request as Request & {
      runtime?: { node?: { req?: IncomingMessage } };
    }
  ).runtime;

  return runtime?.node?.req;
}
