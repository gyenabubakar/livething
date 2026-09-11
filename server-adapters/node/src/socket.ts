import { CloseCodes } from '@wskit/server/errors';
import type {
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  UpgradeDecision,
} from '@wskit/server/adapters';
import type { RawData, WebSocket } from 'ws';
import { closeWebSocket } from './close.ts';

/** Transport functions the engine needs after a WebSocket handshake. */
export interface ConnectionTransport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  backpressureSupported: boolean;
}

/** Inputs required to connect an accepted WebSocket transport to the engine. */
export interface ConnectionBridgeOptions {
  engine: Pick<Engine, 'accept'>;
  token: unknown;
  transport: ConnectionTransport;
  decision: UpgradeDecision;
}

/** Creates the engine connection handle for an accepted transport. */
export function createConnectionBridge(options: ConnectionBridgeOptions): ConnectionHandle {
  const { engine, token, transport, decision } = options;
  const descriptor: ConnectionDescriptor = {
    send: transport.send,
    close: transport.close,
    bufferedAmount: transport.bufferedAmount,
    backpressureSupported: transport.backpressureSupported,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  return engine.accept(token, descriptor);
}

/** Inputs required to connect one `ws` socket to the WSKit engine. */
export interface NodeWebSocketBridgeOptions {
  engine: Pick<Engine, 'accept'>;
  socket: WebSocket;
  decision: UpgradeDecision;
}

/** Creates the engine handle and forwards lifecycle events from a `ws` socket. */
export function createWebSocketBridge(options: NodeWebSocketBridgeOptions): ConnectionHandle {
  const { engine, socket, decision } = options;
  const connection = createConnectionBridge({
    engine,
    token: socket,
    transport: {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      bufferedAmount: () => socket.bufferedAmount,
      backpressureSupported: true,
    },
    decision,
  });

  // These callbacks intentionally allow message, close, and error handling to progress concurrently.
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      closeWebSocket(
        socket,
        CloseCodes.UNSUPPORTED_DATA,
        '[wskit] binary frames are not supported yet',
      );
      return;
    }

    void connection.handleMessage(rawDataToString(data));
  });

  socket.on('close', (code, reason) => {
    void connection.handleClose(code, reason.toString());
  });

  socket.on('error', (error) => {
    void connection.handleError(error);
  });

  return connection;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;

  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();

  if (Array.isArray(data)) return Buffer.concat(data).toString();

  return data.toString();
}
