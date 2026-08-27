import { STATUS_CODES } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Engine, UpgradeDecision } from '@wskit/server/adapters';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import { createClientIpResolver } from './client-ip.ts';
import { requestToWebRequest } from './request.ts';
import type { NodeClientIpConfig } from './client-ip.ts';

/** Creates the Node boundary between an HTTP upgrade and the WSKit engine. */
export function createUpgradeHandler({
  engine,
  onAccepted,
  webSocketServer = new WebSocketServer({ noServer: true }),
  clientIp,
}: NodeUpgradeHandlerOptions): NodeUpgradeHandler {
  const resolveClientIp = createClientIpResolver(clientIp);

  return async (request, socket, head) => {
    const abortController = new AbortController();

    function abort(): void {
      abortController.abort();
    }

    function detachAbortListeners(): void {
      request.off('aborted', abort);
      socket.off('close', abort);
    }

    request.once('aborted', abort);
    socket.once('close', abort);

    let webRequest: Request;
    try {
      webRequest = requestToWebRequest(request, {
        signal: abortController.signal,
        clientIp: resolveClientIp(request),
      });
    } catch {
      detachAbortListeners();
      writeHttpRejection(socket, { reject: true, code: 400, reason: 'Invalid upgrade request' });
      return;
    }

    let decision: UpgradeDecision;
    try {
      decision = await engine.handleUpgrade(webRequest);
    } finally {
      detachAbortListeners();
    }

    if (decision.reject) {
      await rejectUpgrade({ webSocketServer, request, socket, head, decision });
      return;
    }

    let acceptedSocket: WebSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          acceptedSocket = webSocket;
          Promise.resolve(onAccepted(webSocket, request, decision)).then(resolve, reject);
        });
      });
    } catch (error) {
      acceptedSocket?.close(1011, '[wskit] connection setup failed');
      throw error;
    }
  };
}

async function rejectUpgrade({
  webSocketServer,
  request,
  socket,
  head,
  decision,
}: RejectUpgradeOptions): Promise<void> {
  if (decision.code !== undefined && isValidWebSocketCloseCode(decision.code)) {
    await new Promise<void>((resolve, reject) => {
      try {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          try {
            webSocket.close(decision.code, decision.reason ?? 'Upgrade rejected');
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
    return;
  }

  writeHttpRejection(socket, decision);
}

function isValidWebSocketCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

interface RejectUpgradeOptions {
  webSocketServer: NodeWebSocketServer;
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  decision: UpgradeDecision;
}

function writeHttpRejection(socket: Duplex, decision: UpgradeDecision): void {
  const status =
    decision.code !== undefined && decision.code >= 400 && decision.code <= 599
      ? decision.code
      : 403;
  const body = decision.reason ?? 'Upgrade rejected';
  const bodyBytes = Buffer.from(body);
  const statusText = STATUS_CODES[status] ?? 'Forbidden';
  const response = [
    `HTTP/1.1 ${status} ${statusText}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${bodyBytes.byteLength}`,
    '',
    '',
  ].join('\r\n');

  socket.end(Buffer.concat([Buffer.from(response), bodyBytes]));
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

/** Dependencies used to create the Node HTTP upgrade handler. */
export interface NodeUpgradeHandlerOptions {
  engine: Pick<Engine, 'handleUpgrade'>;
  onAccepted: (
    webSocket: WebSocket,
    request: IncomingMessage,
    decision: UpgradeDecision,
  ) => void | Promise<void>;
  webSocketServer?: NodeWebSocketServer;
  clientIp?: NodeClientIpConfig;
}

/** Handles one Node HTTP upgrade event. */
export type NodeUpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => Promise<void>;
