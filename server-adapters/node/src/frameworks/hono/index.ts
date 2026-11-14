import { upgradeWebSocket } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { asUint8Array, ERROR_HEADER } from '@livething/server/adapters';
import { WebSocketServer } from 'ws';
import type { ServerDefinition } from '@livething/server/adapters';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { binding } from '../../binding.ts';
import { closeWebSocket } from '../../close.ts';
import { resolveCompression, resolveMaxMessageBytes } from '../../endpoint.ts';
import { frameData, sendWhenOpen } from '../../socket.ts';
import { createUpgradeLifecycle } from '../../upgrade-lifecycle.ts';
import { isNodeWebSocketUpgrade, isWebSocketUpgrade } from '../../upgrade.ts';
import type { NodeAdmin, NodeConnection, NodeEndpointOptions } from '../../binding.ts';
import type { NodeCompressionOption } from '../../endpoint.ts';

/** One LiveThing definition registered as a Hono WebSocket route. */
export interface HonoEndpoint<TAdmin = NodeAdmin> {
  upgrade: MiddlewareHandler;
  /**
   * The route for the server-sent events stream, its POSTs and their CORS preflight. Mount
   * it on the same path as `upgrade`, for every method. Without `sse()` it answers 426.
   */
  handle: MiddlewareHandler;
  ready(): Promise<void>;
  admin(): Promise<TAdmin>;
}

/** Shared Hono WebSocket transport and lifecycle. */
export interface HonoSetup {
  readonly websocket: { server: WebSocketServer };
  bind<TDefinition extends ServerDefinition>(
    definition: TDefinition,
    options: NodeEndpointOptions,
  ): HonoEndpoint<NodeAdmin<TDefinition>>;
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Options for the shared Hono WebSocket transport. */
export interface HonoSetupOptions {
  webSocketServer?: WebSocketServer;
  /**
   * The `maxPayload` of the `ws` server that all endpoints share, in bytes. Default: 32 MiB.
   * An endpoint's own `maxMessageBytes` must not be larger.
   */
  maxMessageBytes?: number;
  /**
   * Turns on permessage-deflate for the `ws` server that all endpoints share, so messages of at
   * least `threshold` bytes (default 1024) go compressed when the client supports it. Default: off.
   */
  compression?: NodeCompressionOption;
}

/** Creates Hono route bindings without creating or listening on an HTTP server. */
export function setup(setupOptions: HonoSetupOptions = {}): HonoSetup {
  if (setupOptions.webSocketServer && setupOptions.maxMessageBytes !== undefined) {
    throw new Error(
      '[livething] setup() got both webSocketServer and maxMessageBytes. Set maxPayload on your own WebSocketServer instead.',
    );
  }

  if (setupOptions.webSocketServer && setupOptions.compression !== undefined) {
    throw new Error(
      '[livething] setup() got both webSocketServer and compression. Set perMessageDeflate on your own WebSocketServer instead.',
    );
  }

  const node = binding();
  const lifecycle = createUpgradeLifecycle();
  const server =
    setupOptions.webSocketServer ??
    new WebSocketServer({
      noServer: true,
      maxPayload: resolveMaxMessageBytes(setupOptions.maxMessageBytes, 'setup()'),
      perMessageDeflate: resolveCompression(setupOptions.compression, 'setup()'),
    });

  return {
    websocket: { server },

    bind(definition, endpointOptions) {
      // The shared server refuses bigger messages first, so a larger endpoint limit can't work.
      const endpointLimit = resolveMaxMessageBytes(endpointOptions.maxMessageBytes, 'The endpoint');
      const sharedLimit = server.options.maxPayload;
      if (sharedLimit !== undefined && endpointLimit > sharedLimit) {
        throw new Error(
          `[livething] maxMessageBytes (${endpointLimit}) is larger than the shared WebSocket server limit (${sharedLimit}). Raise maxMessageBytes in setup().`,
        );
      }

      const endpoint = node.bind(definition, endpointOptions);
      const connections = new WeakMap<object, NodeConnection>();

      async function route(
        context: Parameters<MiddlewareHandler>[0],
        next: Parameters<MiddlewareHandler>[1],
      ) {
        if (!isWebSocketUpgrade(context.req.header('upgrade'))) return next();

        const incoming = getIncomingRequest(context.env);
        if (!incoming) return noNodeRequest();

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
                // @hono/node-server passes `compress: undefined` to ws unless told, which turns
                // compression off. ws still skips it when it is not negotiated or the frame is small.
                send: (frame) =>
                  sendWhenOpen(rawSocket.readyState, () =>
                    socket.send(frameData(frame), { compress: true }),
                  ),
                close: (code, reason) => socket.close(code, reason),
                terminate: () => rawSocket.terminate(),
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
              // @hono/node-server hands a binary message over as an ArrayBuffer, never a Blob.
              const bytes = asUint8Array(event.data as ArrayBuffer);
              void connections.get(socket)?.binaryMessage(bytes);
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

      async function handle(
        context: Parameters<MiddlewareHandler>[0],
        next: Parameters<MiddlewareHandler>[1],
      ) {
        if (isWebSocketUpgrade(context.req.header('upgrade'))) return next();

        const incoming = getIncomingRequest(context.env);
        const outgoing = (context.env as { outgoing?: ServerResponse }).outgoing;
        if (!incoming || !outgoing) return noNodeRequest();

        const served = await lifecycle.prepare(incoming, async (signal) => {
          // A shutdown ends a request a custom transport still holds, such as a poll.
          signal.addEventListener('abort', () => outgoing.destroy());
          await endpoint.handleNode(incoming, outgoing);
          return true;
        });
        if (!served) outgoing.destroy();

        return RESPONSE_ALREADY_SENT;
      }

      return {
        upgrade: route,
        handle,
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

function noNodeRequest(): Response {
  return new Response('[livething] Hono did not provide a Node request', {
    status: 500,
    headers: { [ERROR_HEADER]: 'no-node-request' },
  });
}

function getIncomingRequest(environment: unknown): IncomingMessage | undefined {
  return (environment as { incoming?: IncomingMessage }).incoming;
}
