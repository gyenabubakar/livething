/* oxlint-disable @typescript-eslint/no-explicit-any -- type-level request matching requires `any` */
import { DisconnectedError, TimeoutError } from '@/errors.ts';
import { Plugin } from '@/plugins/base.ts';
import type { TypeFn } from '@/plugins/types.ts';

// ---------------------------------------------------------------------------
// Type function
// ---------------------------------------------------------------------------

/**
 * Type function that adds `socket.request(event, payload)` — a typed
 * request-response method. Reads `requests` from the contract to determine
 * valid event names, payload types, and response types.
 */
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

/** Configuration for the RequestResponse plugin. */
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
  readonly defaultTimeout: number;

  constructor(options?: RequestResponseOptions) {
    super();
    this.defaultTimeout = options?.timeout ?? 10_000;
  }

  /** Tag an outgoing request with a correlation ID. Default: adds `_correlationId` to the payload. Override to use a different field name. */
  tagRequest(_event: string, payload: unknown, correlationId: string): unknown {
    return { ...(payload as Record<string, unknown>), _correlationId: correlationId };
  }

  /** Extract a correlation ID from an incoming response. Return `null` if not a response. */
  extractId(_event: string, payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    return typeof p._correlationId === 'string' ? p._correlationId : null;
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
    const id = this.helpers.generateId('req');
    const tagged = this.tagRequest(event, payload, id);
    const ms = timeout ?? this.defaultTimeout;

    this.helpers.lazyAcquire();

    return new Promise((resolve, reject) => {
      // cleanup() is extracted because it must run from every exit path:
      // timeout, resolve, reject, and disconnect (onClose). Without a shared
      // function, each path would duplicate the Map deletion + lazyRelease,
      // risking missed cleanup and leaked resources.
      const cleanup = () => {
        this.pending.delete(id);
        this.helpers.lazyRelease();
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Request "${event}"`, ms));
      }, ms);

      // resolve/reject are wrapped (not stored directly) so that each one
      // automatically runs cleanup + clears the timer. This guarantees that
      // no matter which path settles the promise (server response, timeout,
      // or disconnect), resources are always freed.
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          cleanup();
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          cleanup();
          reject(reason);
        },
        timer,
      });

      send(event, tagged);
    });
  }

  override install(socket: Record<string, unknown>) {
    socket.request = (event: string, payload: unknown, options?: { timeout?: number }) => {
      return this.sendRequest(event, payload, this.helpers.rawSend, options?.timeout);
    };

    this.wrapScopedMethods(socket);
  }

  /**
   * Wrap any scoped method (e.g., `socket.channel`, `socket.room`) to add
   * `request()` to the returned endpoint. Uses the endpoint's `_tag` function
   * to scope the payload before delegating to `socket.request()`.
   *
   * "Scoped methods" are factory functions like `socket.channel("chat")` that
   * return an endpoint object. Other plugins register their factory key in
   * `_scopedKeys` during install(). This method iterates that list, wraps each
   * factory, and augments the returned endpoint with `.request()`.
   *
   * The `_tag` convention: each endpoint exposes a `_tag(event, payload)` function
   * that scopes a payload (e.g., adds `_channel: "chat"`). We call it before
   * delegating to the top-level request so the request is sent with the
   * correct scope.
   */
  private wrapScopedMethods(socket: Record<string, unknown>) {
    const scopedKeys = socket._scopedKeys as string[] | undefined;
    if (!scopedKeys?.length) return;

    const socketRequest = socket.request as (
      event: string,
      payload: unknown,
      options?: { timeout?: number },
    ) => Promise<unknown>;

    for (const key of scopedKeys) {
      if (typeof socket[key] !== 'function') continue;

      const original = socket[key] as (name: string) => Record<string, any>;
      socket[key] = (name: string) => {
        const endpoint = original(name);
        const tag = endpoint._tag as ((event: string, payload: unknown) => unknown) | undefined;

        endpoint.request = (event: string, payload: unknown, options?: { timeout?: number }) => {
          const tagged = tag ? tag(event, payload) : payload;
          return socketRequest(event, tagged, options);
        };

        return endpoint;
      };
    }
  }

  override onIncoming(message: { event: string; payload: unknown }) {
    const id = this.extractId(message.event, message.payload);
    if (id === null) return message;

    const pending = this.pending.get(id);
    if (!pending) return message;

    pending.resolve(message.payload);
    return null;
  }

  override onClose(_code: number, _reason: string) {
    for (const [id, pending] of this.pending) {
      pending.reject(new DisconnectedError());
      this.pending.delete(id);
    }
  }
}
