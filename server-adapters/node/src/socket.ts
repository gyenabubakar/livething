import type {
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  TransportFrame,
  UpgradeDecision,
} from '@livething/server/adapters';

/** What a WebSocket `send()` takes for a frame: a string goes as text, bytes go as binary. */
export function frameData(frame: TransportFrame): string | Uint8Array<ArrayBuffer> {
  return frame.kind === 'text' ? frame.text : frame.bytes;
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

/** Transport functions the engine needs after a WebSocket handshake. */
export interface ConnectionTransport {
  /** Return `false` when the frame was not sent, for example because the socket is closing. */
  send(frame: TransportFrame): boolean | void;
  close(code?: number, reason?: string): void;
  /** Optional. Drop the socket with no close handshake, for a client that stopped reading. */
  terminate?(): void;
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
    send: (frame) => transport.send(frame),
    close: (code, reason) => transport.close(code, reason),
    ...(transport.terminate ? { terminate: () => transport.terminate?.() } : {}),
    bufferedAmount: () => transport.bufferedAmount(),
    backpressureSupported: transport.backpressureSupported,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  return engine.accept(token, descriptor);
}
