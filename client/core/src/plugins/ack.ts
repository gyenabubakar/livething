/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level ack matching requires `any` */
import { Plugin } from '@/plugins/base.ts';
import type { TypeFn } from '@/plugins/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

export interface AckTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends { outgoing: infer O extends Record<string, any> }
    ? {
        send: {
          withAck<K extends keyof O & string>(
            event: K,
            payload: O[K],
            options?: { timeout?: number; ttl?: number },
          ): Promise<void>;
        };
      }
    : {};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AckOptions {
  /** Default timeout in ms for all acks. Overridable per-call. Default: `10_000`. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface PendingAck {
  resolve: () => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Enables `socket.send.withAck()`. Tags outgoing messages with an ack ID
 * and detects acknowledgements from the server.
 *
 * Default: uses `_ackId` field. Server responds with
 * `{ event: "_ack", payload: { id: "..." } }`.
 * Override `tagMessage` and `extractId` to customize.
 */
export class Ack extends Plugin<AckTypeFn> {
  id = 'ack';

  private pending = new Map<string, PendingAck>();
  private counter = 0;
  readonly defaultTimeout: number;

  constructor(options?: AckOptions) {
    super();
    this.defaultTimeout = options?.timeout ?? 10_000;
  }

  /** Tag an outgoing message with an ack ID. */
  tagMessage(_event: string, payload: unknown, ackId: string): unknown {
    return { ...(payload as Record<string, unknown>), _ackId: ackId };
  }

  /** Extract an ack ID from an incoming ack message. Return `null` if not an ack. */
  extractId(event: string, payload: unknown): string | null {
    if (event !== '_ack') return null;
    const p = payload as Record<string, unknown>;
    return typeof p.id === 'string' ? p.id : null;
  }

  private generateId(): string {
    return `ack-${++this.counter}-${Date.now()}`;
  }

  /**
   * Send a message and wait for the server to acknowledge it. Called by the
   * socket when `socket.send.withAck()` is invoked.
   */
  sendWithAck(
    event: string,
    payload: unknown,
    send: (event: string, payload: unknown) => void,
    timeout?: number,
  ): Promise<void> {
    const id = this.generateId();
    const tagged = this.tagMessage(event, payload, id);
    const ms = timeout ?? this.defaultTimeout;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ack for "${event}" timed out after ${ms}ms`));
      }, ms);

      this.pending.set(id, { resolve, reject, timer });
      send(event, tagged);
    });
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const id = this.extractId(message.event, message.payload);
    if (id === null) return message;

    const pending = this.pending.get(id);
    if (!pending) return message;

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve();
    return null;
  }

  override onClose(_code: number, _reason: string) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
      this.pending.delete(id);
    }
  }
}
