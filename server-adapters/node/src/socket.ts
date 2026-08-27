import type {
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  UpgradeDecision,
} from '@wskit/server/adapters';
import type { RawData, WebSocket } from 'ws';

/** Inputs required to connect one `ws` socket to the WSKit engine. */
export interface NodeWebSocketBridgeOptions {
  engine: Pick<Engine, 'accept'>;
  socket: WebSocket;
  decision: UpgradeDecision;
}

/** Creates the engine handle and forwards lifecycle events from a `ws` socket. */
export function createWebSocketBridge({
  engine,
  socket,
  decision,
}: NodeWebSocketBridgeOptions): ConnectionHandle {
  const descriptor: ConnectionDescriptor = {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    bufferedAmount: () => socket.bufferedAmount,
    backpressureSupported: true,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  const connection = engine.accept(socket, descriptor);

  // These callbacks intentionally allow message, close, and error handling to progress concurrently.
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      socket.close(1003, '[wskit] binary frames are not supported yet');
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
