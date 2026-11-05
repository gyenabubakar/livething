/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching needs `any` to stay generic */
import type { BinaryInput } from '@livething/core';
import type { SendOptions } from '~/messaging.ts';
import type { StreamTriggerOptions } from '~/primitives/stream/types.ts';
import type { Primitive, PrimitiveIdentity } from '~/primitives/types.ts';
import type { IncomingOf, NudgesOf, OutgoingOf, StreamHandle, StreamHandlers } from '~/types.ts';

/** One binary message as the client gets it: the info, and the bytes. */
export interface BinaryItem<TInfo> {
  info: TInfo;
  /**
   * A view of the received frame, so `bytes.buffer` is the whole frame: copy the bytes
   * with `bytes.slice()` to keep them or to pass an `ArrayBuffer` on.
   */
  bytes: Uint8Array;
}

/**
 * The answer a `binary.onRequest` handler returns: the info, and the bytes (none means zero
 * bytes). When the server checks no info (`in` has no schema), the info is `null`.
 */
export interface BinaryAnswer<TInfo> {
  info: [TInfo] extends [void] ? null | undefined : TInfo;
  bytes?: BinaryInput;
}

type Requests = Record<string, { payload: any; response: any }>;
type Streams = Record<string, { payload: any; chunk: any }>;

/**
 * The `on` and `send` of a `.binary` key, typed from one scope's `binary` contract. `on`
 * appears only when the scope receives binary events, and `send` only when it sends them.
 */
type BinaryEvents<TBinary> = (keyof IncomingOf<TBinary> extends never
  ? {}
  : {
      /**
       * Listen for a binary event. The handler gets the info, then the bytes. The bytes are
       * a view of the received frame, so `bytes.buffer` is the whole frame: copy them with
       * `bytes.slice()` to keep them or to pass an `ArrayBuffer` on. Call the returned
       * function to stop listening.
       */
      on<K extends keyof IncomingOf<TBinary> & string>(
        event: K,
        handler: (info: IncomingOf<TBinary>[K], bytes: Uint8Array) => void,
      ): () => void;
    }) &
  (keyof OutgoingOf<TBinary> extends never
    ? {}
    : {
        /**
         * Send a binary event: the info, then the bytes (none means zero bytes). Returns
         * `true` when the socket sent or buffered it, and `false` when it was dropped,
         * also when the whole frame is over `binary({ maxFrameBytes })`.
         */
        send<K extends keyof OutgoingOf<TBinary> & string>(
          event: K,
          info: OutgoingOf<TBinary>[K],
          bytes?: BinaryInput,
          options?: SendOptions,
        ): boolean;
      });

/** `binary.request`, for one scope's binary `clientRequests`. */
interface BinaryRequestMethod<R extends Requests> {
  /**
   * Send a binary request: the info, then the bytes (none means zero bytes). Resolves with
   * the info and the bytes of the binary reply. Rejects with `Timeout`, `Disconnected`, a
   * typed error from the server, or `request-invalid-response` for a text reply. Rejects
   * at once when the frame is over `binary({ maxFrameBytes })`. To pass options with no
   * bytes, pass `undefined` for the bytes.
   */
  request<K extends keyof R & string>(
    event: K,
    info: R[K]['payload'],
    bytes?: BinaryInput,
    options?: { timeout?: number },
  ): Promise<BinaryItem<R[K]['response']>>;
}

/** `binary.onRequest`, for one scope's binary `serverRequests`. */
interface BinaryOnRequestMethod<R extends Requests> {
  /**
   * Answer a binary request from the server. The handler gets the info and the bytes, and
   * returns (or resolves) `{ info, bytes }`, sent back as one binary message. When the
   * handler throws, or no handler is registered, the server's request rejects with
   * `request-no-response`. Returns an unsubscribe. A second handler for the same event
   * replaces the first.
   */
  onRequest<K extends keyof R & string>(
    event: K,
    handler: (
      info: R[K]['payload'],
      bytes: Uint8Array,
    ) => BinaryAnswer<R[K]['response']> | Promise<BinaryAnswer<R[K]['response']>>,
  ): () => void;
}

/** `binary.stream` and `binary.onStream`, for one scope's binary `streams`. */
interface BinaryStreamMethods<S extends Streams> {
  /**
   * Start a binary stream: the info, then the bytes (none means zero bytes). The handle is
   * the same as a JSON stream's, and each item is `{ info, bytes }`. Rejects at once when
   * the frame is over `binary({ maxFrameBytes })`.
   */
  stream<K extends keyof S & string>(
    event: K,
    info: S[K]['payload'],
    bytes?: BinaryInput,
    options?: StreamTriggerOptions,
  ): Promise<StreamHandle<BinaryItem<S[K]['chunk']>, NudgesOf<S[K]>>>;
  /** Listen to a broadcast binary stream. Each chunk is `{ info, bytes }`. */
  onStream<K extends keyof S & string>(
    event: K,
    handlers: StreamHandlers<BinaryItem<S[K]['chunk']>>,
  ): () => void;
}

/**
 * The `.binary` key of one scope, for the primitives registered (their tags in `TTags`).
 * Each side with entries adds its method: `binary.on`/`send` from `binary()`, and
 * `binary.request`, `binary.onRequest` and `binary.stream`/`onStream` when
 * `clientRequests()`, `serverRequests()` and `stream()` are registered too. Without that
 * primitive, the method is a stub: calling it is a type error that names the primitive.
 */
type BinarySurface<B, TTags extends string> = BinaryEvents<B> &
  (B extends { clientRequests: infer R extends Requests }
    ? {} extends R
      ? {}
      : 'clientRequests' extends TTags
        ? BinaryRequestMethod<R>
        : {
            request: {
              error: '[livething] binary.request needs the clientRequests() primitive — add clientRequests() to client()';
            };
          }
    : {}) &
  (B extends { serverRequests: infer R extends Requests }
    ? {} extends R
      ? {}
      : 'serverRequests' extends TTags
        ? BinaryOnRequestMethod<R>
        : {
            onRequest: {
              error: '[livething] binary.onRequest needs the serverRequests() primitive — add serverRequests() to client()';
            };
          }
    : {}) &
  (B extends { streams: infer S extends Streams }
    ? {} extends S
      ? {}
      : 'stream' extends TTags
        ? BinaryStreamMethods<S>
        : {
            stream: {
              error: '[livething] binary.stream needs the stream() primitive — add stream() to client()';
            };
            onStream: {
              error: '[livething] binary.onStream needs the stream() primitive — add stream() to client()';
            };
          }
    : {});

/**
 * The `.binary` key of a socket or a channel handle whose contract has binary entries,
 * when `binary()` is registered. One conditional for a scope without binary.
 */
export type BinaryScopeSurface<C, TTags extends string> = C extends { binary: infer B }
  ? keyof B extends never
    ? {}
    : 'binary' extends TTags
      ? { readonly binary: BinarySurface<B, TTags> }
      : {}
  : {};

/**
 * The whole `.binary` key of one scope, typed from its `binary` contract: every method its
 * entries call for. A plugin's scoped socket has this type, and it can type a variable.
 */
export type BinaryMessaging<TBinary> = BinarySurface<
  TBinary,
  'clientRequests' | 'serverRequests' | 'stream'
>;

/** The descriptor `binary()` returns. `client()` adds `.binary`, from the registered tags. */
export type BinaryPrimitive = Primitive & PrimitiveIdentity<'binary'>;

/** Options for `binary()`. */
export interface BinaryOptions {
  /**
   * The largest frame `binary.send`, `binary.request` and `binary.stream` accept, in bytes,
   * counting the header, the info and the metadata too. A bigger frame is never sent or
   * queued. Default: `33554432` (32 MiB), the same as the server adapters.
   */
  maxFrameBytes?: number;
}
