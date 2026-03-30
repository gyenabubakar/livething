/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level ack matching requires `any` */
import { DisconnectedError, TimeoutError } from '@/errors.ts';
import { Plugin } from '@/plugins/base.ts';
import type { TypeFn } from '@/plugins/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

/**
 * Type function that adds `socket.send.withAck(event, payload)` — a typed
 * send-with-acknowledgement method. Reads `outgoing` from the contract to
 * determine valid event names and payload types. Resolves when the server
 * confirms receipt.
 */
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

/** Configuration for the Ack plugin. */
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
  readonly defaultTimeout: number;

  constructor(options?: AckOptions) {
    super();
    this.defaultTimeout = options?.timeout ?? 10_000;
  }

  /** Tag an outgoing message with an ack ID. Default: adds `_ackId` to the payload. Override to use a different field name. */
  tagMessage(_event: string, payload: unknown, ackId: string): unknown {
    return { ...(payload as Record<string, unknown>), _ackId: ackId };
  }

  /** Extract an ack ID from an incoming ack message. Return `null` if not an ack. */
  extractId(event: string, payload: unknown): string | null {
    if (event !== '_ack') return null;
    const p = payload as Record<string, unknown>;
    return typeof p.id === 'string' ? p.id : null;
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
    ttl?: number,
  ): Promise<void> {
    const id = this.helpers.generateId('ack');
    const tagged = this.tagMessage(event, payload, id);
    const ms = timeout ?? this.defaultTimeout;

    this.helpers.lazyAcquire();

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        this.helpers.lazyRelease();
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Ack for "${event}"`, ms));
      }, ms);

      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          cleanup();
          resolve();
        },
        reject: (reason) => {
          clearTimeout(timer);
          cleanup();
          reject(reason);
        },
        timer,
      });

      // Use helpers.send for buffer support + TTL, fall back to raw send
      if (ttl !== undefined) {
        this.helpers.send(event, tagged, { ttl });
      } else {
        send(event, tagged);
      }
    });
  }

  override install(socket: Record<string, unknown>) {
    const existingSend = socket.send;
    if (typeof existingSend === 'function') {
      const sendObj = existingSend as unknown as Record<string, unknown>;
      sendObj.withAck = (
        event: string,
        payload: unknown,
        options?: { timeout?: number; ttl?: number },
      ) => {
        return this.sendWithAck(
          event,
          payload,
          this.helpers.rawSend,
          options?.timeout,
          options?.ttl,
        );
      };
    }

    this.wrapScopedMethods(socket);
  }

  /**
   * Wrap any scoped method to add `send.withAck()` to the returned endpoint.
   * Uses the endpoint's `_tag` and `send` to scope and send the message.
   */
  private wrapScopedMethods(socket: Record<string, unknown>) {
    const scopedKeys = socket._scopedKeys as string[] | undefined;
    if (!scopedKeys?.length) return;

    for (const key of scopedKeys) {
      if (typeof socket[key] !== 'function') continue;

      const original = socket[key] as (name: string) => Record<string, any>;
      socket[key] = (name: string) => {
        const endpoint = original(name);
        const tag = endpoint._tag as ((event: string, payload: unknown) => unknown) | undefined;
        const endpointSend = endpoint.send;

        if (typeof endpointSend === 'function') {
          endpointSend.withAck = (
            event: string,
            payload: unknown,
            options?: { timeout?: number; ttl?: number },
          ) => {
            const tagged = tag ? tag(event, payload) : payload;
            return this.sendWithAck(
              event,
              tagged,
              this.helpers.rawSend,
              options?.timeout,
              options?.ttl,
            );
          };
        }

        return endpoint;
      };
    }
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const id = this.extractId(message.event, message.payload);
    if (id === null) return message;

    const pending = this.pending.get(id);
    if (!pending) return message;

    pending.resolve();
    return null;
  }

  override onClose(_code: number, _reason: string) {
    for (const [id, pending] of this.pending) {
      pending.reject(new DisconnectedError());
      this.pending.delete(id);
    }
  }
}
