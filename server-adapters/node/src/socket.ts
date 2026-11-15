import type {
  AuthDecision,
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  TransportConnection,
  TransportFrame,
} from '@livething/server/adapters';
import type { WebSocket } from 'ws';

/** What a WebSocket `send()` takes for a frame: a string goes as text, bytes go as binary. */
export function frameData(frame: TransportFrame): string | Uint8Array<ArrayBuffer> {
  return frame.kind === 'text' ? frame.text : frame.bytes;
}

/**
 * The UTF-8 bytes of shared text frames, or `null` after the first send. A broadcast hands every
 * member the same frame object, and `ws` turns a string into bytes on each send, so the bytes are
 * made on the second send and reused. A shared frame that reaches one socket never pays for them.
 */
const sharedTextBytes = new WeakMap<TransportFrame, Buffer | null>();

/** Send one frame on a `ws` socket: text as a text message, bytes as a binary message. */
export function sendToWs(socket: Pick<WebSocket, 'send'>, frame: TransportFrame): void {
  if (frame.kind === 'bytes') {
    socket.send(frame.bytes);
    return;
  }

  if (!frame.shared) {
    socket.send(frame.text);
    return;
  }

  let bytes = sharedTextBytes.get(frame);
  if (bytes === undefined) {
    sharedTextBytes.set(frame, null);
    socket.send(frame.text);
    return;
  }

  if (bytes === null) {
    bytes = Buffer.from(frame.text);
    sharedTextBytes.set(frame, bytes);
  }

  socket.send(bytes, { binary: false });
}

/** The WebSocket `readyState` of an open socket. */
const WEB_SOCKET_OPEN = 1;

/**
 * Send one frame only while the socket is open. Node WebSocket libraries drop
 * or reject a send on a closing socket in different ways, so every transport
 * reports it the same way: as not delivered. A socket that does not expose
 * `readyState` is always sent to.
 */
export function sendWhenOpen(readyState: number | undefined, send: () => unknown): boolean {
  if (readyState !== undefined && readyState !== WEB_SOCKET_OPEN) return false;

  send();
  return true;
}

/**
 * Transport functions the engine needs for an accepted connection. `send()` returns `false`
 * when the frame was not sent, for example because the socket is closing.
 */
export type ConnectionTransport = TransportConnection;

/** Inputs required to connect an accepted WebSocket transport to the engine. */
export interface ConnectionBridgeOptions {
  engine: Pick<Engine, 'accept'>;
  token: unknown;
  transport: ConnectionTransport;
  decision: AuthDecision;
}

/** Creates the engine connection handle for an accepted transport. */
export function createConnectionBridge(options: ConnectionBridgeOptions): ConnectionHandle {
  const { engine, token, transport, decision } = options;
  const descriptor: ConnectionDescriptor = {
    send: (frame) => transport.send(frame),
    close: (code, reason) => transport.close(code, reason),
    ...(transport.terminate ? { terminate: () => transport.terminate?.() } : {}),
    bufferedAmount: () => transport.bufferedAmount(),
    backpressureSupported: transport.backpressureSupported,
    secret: transport.secret ?? null,
    maxPostBytes: transport.maxPostBytes ?? null,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  return engine.accept(token, descriptor);
}
