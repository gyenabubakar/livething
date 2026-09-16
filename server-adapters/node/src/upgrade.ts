import { STATUS_CODES } from 'node:http';
import { CloseCodes } from '@wskit/server/errors';
import type { UpgradeDecision } from '@wskit/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket } from 'ws';
import { closeWebSocket } from './close.ts';
import { createNodeUpgradeAbort } from './upgrade-lifecycle.ts';
import type { NodeBindingEndpoint, NodeConnection } from './binding.ts';

export function upgradeRejection(decision: UpgradeDecision): { body: string; status: number } {
  const status =
    decision.code !== undefined && decision.code >= 400 && decision.code <= 599
      ? decision.code
      : 403;
  const body = decision.reason ?? 'Upgrade rejected';

  return { body, status };
}

export function isSocketRejection(decision: UpgradeDecision): boolean {
  return decision.code !== undefined && decision.code >= 1000;
}

export function createHttpRejectionResponse(decision: UpgradeDecision): Response {
  const { body, status } = upgradeRejection(decision);

  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** The small part of `ws.WebSocketServer` needed by the adapter. */
export interface NodeWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (webSocket: WebSocket, request: IncomingMessage) => void,
  ): void;
}

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
        if (!accepted) reject(new Error('[wskit] WebSocket upgrade closed before acceptance'));
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
      closeWebSocket(acceptedSocket, CloseCodes.INTERNAL_ERROR, '[wskit] connection setup failed');
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

function webSocketTransport(socket: WebSocket) {
  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    bufferedAmount: () => socket.bufferedAmount,
    backpressureSupported: true,
  };
}

function attachAcceptedWebSocket(socket: WebSocket, connection: NodeConnection): void {
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      closeWebSocket(
        socket,
        CloseCodes.UNSUPPORTED_DATA,
        '[wskit] binary frames are not supported yet',
      );
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
