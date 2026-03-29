/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level request matching requires `any` */
import { Plugin } from '@/plugins/base.ts';
import type { TypeFn } from '@/plugins/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

export interface RequestResponseTypeFn extends TypeFn {
  readonly _api: this['_contract'] extends {
    requests: infer R extends Record<string, { payload: any; response: any }>;
  }
    ? {
        request<K extends keyof R & string>(
          event: K,
          payload: R[K]['payload'],
          options?: { timeout?: number },
        ): Promise<R[K]['response']>;
      }
    : {};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RequestResponseOptions {
  /** Default timeout in ms for all requests. Overridable per-call. Default: `10_000`. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Enables `socket.request()`. Tags outgoing requests with a correlation ID
 * and matches incoming responses.
 *
 * Default: uses `_correlationId` field. Override `tagRequest` and `extractId`
 * to customize.
 */
export class RequestResponse extends Plugin<
  RequestResponseTypeFn,
  { requests: Record<string, any> }
> {
  id = 'request-response';

  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  readonly defaultTimeout: number;

  constructor(options?: RequestResponseOptions) {
    super();
    this.defaultTimeout = options?.timeout ?? 10_000;
  }

  /** Tag an outgoing request with a correlation ID. */
  tagRequest(_event: string, payload: unknown, correlationId: string): unknown {
    return { ...(payload as Record<string, unknown>), _correlationId: correlationId };
  }

  /** Extract a correlation ID from an incoming response. Return `null` if not a response. */
  extractId(_event: string, payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    return typeof p._correlationId === 'string' ? p._correlationId : null;
  }

  /** Generate a unique correlation ID. */
  private generateId(): string {
    return `req-${++this.counter}-${Date.now()}`;
  }

  /**
   * Send a request and wait for the matching response. Called by the socket
   * when `socket.request()` is invoked.
   */
  sendRequest(
    event: string,
    payload: unknown,
    send: (event: string, payload: unknown) => void,
    timeout?: number,
  ): Promise<unknown> {
    const id = this.generateId();
    const tagged = this.tagRequest(event, payload, id);
    const ms = timeout ?? this.defaultTimeout;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${event}" timed out after ${ms}ms`));
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
    pending.resolve(message.payload);
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
