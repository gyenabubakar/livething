import type {
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  UpgradeDecision,
} from '@livething/server/adapters';

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
  send(data: string): boolean | void;
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
    send: (data) => transport.send(data),
    close: (code, reason) => transport.close(code, reason),
    bufferedAmount: () => transport.bufferedAmount(),
    backpressureSupported: transport.backpressureSupported,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  return engine.accept(token, descriptor);
}
