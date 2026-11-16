import { STATUS_CODES } from 'node:http';
import { asUint8Array } from '@livething/server/adapters';
import { CloseCodes } from '@livething/server/errors';
import type { AuthDecision } from '@livething/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket, WebSocketServer } from 'ws';
import { closeWebSocket } from './close.ts';
import { sendToWs, sendWhenOpen, terminateWs, wsBufferedAmount } from './socket.ts';
import { createNodeUpgradeAbort } from './upgrade-lifecycle.ts';
import { gatesItsOwnWrites } from './write-gate.ts';
import type { NodeBindingEndpoint, NodeConnection } from './binding.ts';
import type { ConnectionTransport } from './socket.ts';

/** The HTTP status and body of an `authenticate` rejection that is not a close code. */
export function upgradeRejection(decision: AuthDecision): { body: string; status: number } {
  const status =
    decision.code !== undefined && decision.code >= 400 && decision.code <= 599
      ? decision.code
      : 403;
  const body = decision.reason ?? 'Authentication rejected';

  return { body, status };
}

/** Reports whether an `Upgrade` header value asks for a WebSocket handshake. */
export function isWebSocketUpgrade(upgradeHeader: string | null | undefined): boolean {
  return upgradeHeader?.toLowerCase() === 'websocket';
}

export function invalidUpgradeResponse(): Response {
  return new Response('Invalid Upgrade header', {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Reports whether a Node request asks for a WebSocket handshake. */
export function isNodeWebSocketUpgrade(request: IncomingMessage): boolean {
  const connection = request.headers.connection ?? '';
  const asksForUpgrade = connection
    .split(',')
    .some((token) => token.trim().toLowerCase() === 'upgrade');

  return asksForUpgrade && isWebSocketUpgrade(request.headers.upgrade);
}

export function isSocketRejection(decision: AuthDecision): boolean {
  return decision.code !== undefined && decision.code >= 1000;
}

export function createHttpRejectionResponse(decision: AuthDecision): Response {
  const { body, status } = upgradeRejection(decision);

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** The small part of `ws.WebSocketServer` needed by the adapter. */
export type NodeWebSocketServer = Pick<WebSocketServer, 'handleUpgrade'>;

/** Dependencies used to bind a public Node integration endpoint to `upgrade`. */
export interface NodeUpgradeBindingOptions {
  endpoint: NodeBindingEndpoint;
  webSocketServer: NodeWebSocketServer;
}

interface NodeUpgradeRequest extends NodeUpgradeBindingOptions {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

/**
 * Turns a binding endpoint into a native Node `upgrade` listener.
 *
 * This is kept private to the direct Node setup. Other hosts use the same
 * `NodeBindingEndpoint` through their own WebSocket route lifecycle.
 */
export function createNodeUpgradeHandler(
  options: NodeUpgradeBindingOptions,
): (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> {
  const { endpoint, webSocketServer } = options;

  return (request, socket, head) =>
    handleNodeUpgrade({ endpoint, webSocketServer, request, socket, head });
}

async function handleNodeUpgrade(options: NodeUpgradeRequest): Promise<void> {
  const { endpoint, webSocketServer, request, socket, head } = options;
  if (!isNodeWebSocketUpgrade(request)) {
    await writeHttpResponse(socket, invalidUpgradeResponse());
    return;
  }

  const abort = createNodeUpgradeAbort(request);

  let upgrade;
  try {
    upgrade = await endpoint.prepareNode(request, { signal: abort.signal });
  } finally {
    abort.dispose();
  }

  if (abort.signal.aborted) {
    socket.destroy();
    return;
  }

  if (upgrade.type === 'http') {
    await writeHttpResponse(socket, upgrade.response);
    return;
  }

  let acceptedSocket: WebSocket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let accepted = false;
      function rejectClosedUpgrade(): void {
        if (!accepted) reject(new Error('[livething] WebSocket upgrade closed before acceptance'));
      }

      function detachListeners(): void {
        socket.off('close', rejectClosedUpgrade);
        socket.off('error', rejectClosedUpgrade);
      }

      socket.once('close', rejectClosedUpgrade);
      socket.once('error', rejectClosedUpgrade);
      try {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          accepted = true;
          acceptedSocket = webSocket;
          detachListeners();
          try {
            if (upgrade.type === 'socket') {
              closeWebSocket(webSocket, upgrade.code, upgrade.reason);
            } else {
              attachAcceptedWebSocket(webSocket, upgrade.accept(webSocketTransport(webSocket)));
            }

            resolve();
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        detachListeners();
        reject(error);
      }
    });
  } catch (error) {
    if (acceptedSocket) {
      closeWebSocket(
        acceptedSocket,
        CloseCodes.INTERNAL_ERROR,
        '[livething] connection setup failed',
      );
    }

    throw error;
  }
}

async function writeHttpResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const statusText = STATUS_CODES[response.status] ?? 'Forbidden';
  const headers = new Headers(response.headers);
  headers.set('Connection', 'close');
  if (!headers.has('Content-Length')) headers.set('Content-Length', String(body.byteLength));

  const lines = [`HTTP/1.1 ${response.status} ${statusText}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  lines.push('', '');
  socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')), body]));
}

function webSocketTransport(socket: WebSocket): ConnectionTransport {
  return gatesItsOwnWrites({
    send: (frame) => sendWhenOpen(socket.readyState, () => sendToWs(socket, frame)),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => terminateWs(socket),
    bufferedAmount: () => wsBufferedAmount(socket),
    backpressureSupported: true,
  });
}

/**
 * The bytes of a binary message from `ws`, as a plain `Uint8Array`. A small `Buffer` is a view
 * into a shared pool, so this keeps its offset and length instead of reading `.buffer` whole.
 */
export function rawDataToBytes(data: RawData): Uint8Array {
  return asUint8Array(Array.isArray(data) ? Buffer.concat(data) : data);
}

function attachAcceptedWebSocket(socket: WebSocket, connection: NodeConnection): void {
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      void connection.binaryMessage(rawDataToBytes(data));
      return;
    }

    void connection.message(rawDataToString(data));
  });
  socket.on('close', (code, reason) => {
    void connection.close(code, reason.toString());
  });
  socket.on('error', (error) => {
    void connection.error(error);
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;

  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();

  if (Array.isArray(data)) return Buffer.concat(data).toString();

  return data.toString();
}
