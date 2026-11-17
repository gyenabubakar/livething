import type { TransportConnection } from './transports.ts';
import type { AuthDecision, ConnectionDescriptor, TransportFrame } from './types.ts';

/**
 * The engine's descriptor of one accepted transport. A class, not closures or a spread: every
 * connection holds one for its whole life, its methods stay on the prototype, and a transport
 * that is a class instance keeps its `this`.
 */
class TransportDescriptor implements ConnectionDescriptor {
  readonly transport: TransportConnection;
  readonly backpressureSupported: boolean;
  readonly secret: string | null;
  readonly maxPostBytes: number | null;
  readonly userId: string;
  readonly meta: Record<string, unknown>;
  readonly tags: NonNullable<ConnectionDescriptor['tags']>;

  constructor(transport: TransportConnection, decision: AuthDecision) {
    this.transport = transport;
    this.backpressureSupported = transport.backpressureSupported;
    this.secret = transport.secret ?? null;
    this.maxPostBytes = transport.maxPostBytes ?? null;

    this.userId = decision.userId ?? '';
    this.meta = decision.meta ?? {};
    this.tags = decision.tags ?? [];
  }

  send(frame: TransportFrame): unknown {
    return this.transport.send(frame);
  }

  close(code?: number, reason?: string): void {
    this.transport.close(code, reason);
  }

  bufferedAmount(): number {
    return this.transport.bufferedAmount();
  }
}

/** The engine checks whether a descriptor has `terminate`, so only these have one. */
class TerminableDescriptor extends TransportDescriptor {
  terminate(): void {
    this.transport.terminate?.();
  }
}

/** The descriptor `engine.accept` takes for a transport the app's `authenticate` accepted. */
export function transportDescriptor(
  transport: TransportConnection,
  decision: AuthDecision,
): ConnectionDescriptor {
  return transport.terminate
    ? new TerminableDescriptor(transport, decision)
    : new TransportDescriptor(transport, decision);
}
