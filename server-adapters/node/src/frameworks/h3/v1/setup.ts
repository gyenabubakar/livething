import type { ServerDefinition } from '@livething/server/adapters';
import type { RawData } from 'ws';
import { binding } from '../../../binding.ts';
import { closeWebSocket } from '../../../close.ts';
import { frameData, sendWhenOpen } from '../../../socket.ts';
import { invalidUpgradeResponse, isWebSocketUpgrade, rawDataToBytes } from '../../../upgrade.ts';
import { createWebUpgradeLifecycle } from '../../../web-upgrade-lifecycle.ts';
import type {
  NodeAdmin,
  NodeConnection,
  NodeEndpointOptions,
  NodeUpgrade,
} from '../../../binding.ts';

interface H3V1UpgradeRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly context?: Record<string, unknown>;
}

interface H3V1MessageEvent {
  readonly data: unknown;
}

interface H3V1WebSocket {
  readonly bufferedAmount?: number;
  readonly readyState?: number;
  addEventListener(type: 'message', listener: (event: H3V1MessageEvent) => void): void;
}

interface H3V1Peer {
  readonly context: Record<string, unknown>;
  readonly websocket: Partial<H3V1WebSocket>;
  send(data: unknown, options?: { compress?: boolean }): unknown;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface H3V1Hooks {
  upgrade(request: H3V1UpgradeRequest): Promise<Response | void>;
  open(peer: H3V1Peer): void;
  close(peer: H3V1Peer, details: { code?: number; reason?: string }): void;
  error(peer: H3V1Peer, error: unknown): void;
}

type DefineWebSocketHandler<THandler> = (hooks: Partial<H3V1Hooks>) => THandler;

/** Node endpoint options available through H3 v1's public upgrade request. */
export type H3V1EndpointOptions = Omit<NodeEndpointOptions, 'clientIp'> & {
  clientIp?: never;
};

/** One LiveThing definition registered as an H3 v1 and CrossWS WebSocket route. */
export interface H3V1Endpoint<THandler, TAdmin = NodeAdmin> {
  upgrade: THandler;
  ready(): Promise<void>;
  admin(): Promise<TAdmin>;
}

/** Shared lifecycle for H3 v1 and CrossWS WebSocket routes. */
export interface H3V1Setup<THandler> {
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: H3V1EndpointOptions,
  ): H3V1Endpoint<THandler, NodeAdmin<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createH3V1Setup<THandler>(
  defineWebSocketHandler: DefineWebSocketHandler<THandler>,
): H3V1Setup<THandler> {
  const node = binding();
  const lifecycle = createWebUpgradeLifecycle();

  return {
    bind(definition, options) {
      if ((options as NodeEndpointOptions).clientIp !== undefined) {
        throw new TypeError('[livething] H3 v1 does not expose the Node client IP');
      }

      const endpoint = node.bind(definition, options);
      const connections = new WeakMap<H3V1Peer, NodeConnection>();

      const route = defineWebSocketHandler({
        async upgrade(request) {
          if (!isWebSocketUpgrade(request.headers.get('upgrade'))) {
            return toH3V1HttpRejection(invalidUpgradeResponse());
          }

          let webRequest: Request;
          try {
            webRequest = createWebRequest(request);
          } catch {
            return new Response('Invalid upgrade request', { status: 400 });
          }

          let upgrade: NodeUpgrade | undefined;
          try {
            upgrade = await lifecycle.prepare((signal) =>
              endpoint.prepare(
                new Request(webRequest, {
                  signal,
                }),
              ),
            );
          } catch {
            return new Response('Upgrade preparation failed', { status: 500 });
          }

          if (!upgrade) return new Response(null, { status: 503 });

          if (!request.context) {
            return new Response('[livething] H3 did not provide an upgrade context', {
              status: 500,
            });
          }

          request.context.upgrade = upgrade;

          if (upgrade.type === 'http') return toH3V1HttpRejection(upgrade.response);
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

          const websocket = peer.websocket;
          if (typeof websocket.addEventListener !== 'function') {
            closeWebSocket(peer, 1011, '[livething] H3 did not provide a WebSocket');
            return;
          }

          try {
            const connection = upgrade.accept({
              // CrossWS passes `compress: undefined` to ws unless told, which turns compression off.
              // ws still skips it when permessage-deflate is not negotiated or the frame is small.
              send: (frame) =>
                sendWhenOpen(websocket.readyState, () =>
                  peer.send(frameData(frame), { compress: true }),
                ),
              close: (code, reason) => peer.close(code, reason),
              terminate: () => peer.terminate(),
              bufferedAmount: () => websocket.bufferedAmount ?? 0,
              backpressureSupported: typeof websocket.bufferedAmount === 'number',
            });
            connections.set(peer, connection);

            websocket.addEventListener('message', (event) => {
              if (typeof event.data !== 'string') {
                // The ws socket under crossws 0.3 hands a binary message over as a Buffer.
                const bytes = rawDataToBytes(event.data as RawData);
                void connections.get(peer)?.binaryMessage(bytes);
                return;
              }

              void connections.get(peer)?.message(event.data);
            });
          } catch {
            closeWebSocket(peer, 1011, '[livething] connection setup failed');
          }
        },

        close(peer, details) {
          void connections.get(peer)?.close(details.code ?? 1000, details.reason ?? '');
          connections.delete(peer);
        },

        error(peer, error) {
          void connections.get(peer)?.error(error);
        },
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

function createWebRequest(request: H3V1UpgradeRequest): Request {
  if (request.url.includes('\\')) {
    throw new TypeError('[livething] request target contains a backslash');
  }

  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (!host || url.host !== new URL(`http://${host}`).host) {
    throw new TypeError('[livething] request target authority does not match Host');
  }

  return new Request(url, {
    method: 'GET',
    headers: request.headers,
  });
}

// crossws 0.3 URL-encodes the headers of a refused upgrade (h3js/crossws#186,
// fixed only in 0.4.5), so send none rather than broken ones.
function toH3V1HttpRejection(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
  });
}
