import type {
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  UpgradeDecision,
} from '@livething/server/adapters';

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
