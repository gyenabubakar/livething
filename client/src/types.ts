/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching is intentionally loose */
import type { LiveThingError } from '@livething/core';
import type { Messaging } from '~/messaging.ts';

/**
 * The single interface you define to type your socket. Every key is optional —
 * leave one out and that part of the API disappears.
 *
 * Note that `incoming`/`outgoing` are from the client's point of view: what the
 * server sends to you is your `incoming`, what you send to the server is your
 * `outgoing` (the mirror image of the server's contract).
 *
 * ```ts
 * interface MySocket {
 *   incoming: { notification: { title: string } };
 *   outgoing: { 'mark-read': { id: string } };
 *   channels: { chat: { incoming: { message: { text: string } } } };
 *   clientRequests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
 *   errors: { forbidden: { reason: string } };
 * }
 * ```
 */
export interface SocketContract {
  /** Events the server sends you (top-level, not inside a channel). */
  incoming?: Record<string, unknown>;
  /** Events you send the server (top-level). */
  outgoing?: Record<string, unknown>;
  /** Server-managed rooms you subscribe to. Needs the `channels` primitive. */
  channels?: Record<string, ScopeContract>;
  /** Streaming event definitions. Needs the `stream` primitive. */
  streams?: Record<string, StreamContract>;
  /** Request/response pairs. Needs the `clientRequests` primitive. */
  clientRequests?: Record<string, RequestContract>;
  /** Requests the server asks you (server→client). Needs the `serverRequests` primitive. */
  serverRequests?: Record<string, RequestContract>;
  /** Typed errors the server can send, so you can match on them. */
  errors?: Record<string, unknown>;
  /** Binary events (top-level). Needs the `binary` primitive. */
  binary?: BinaryContract;
}

/**
 * The binary entries of one scope. Each value is the type of the info; the bytes are
 * always a `Uint8Array`.
 */
export interface BinaryContract {
  /** Binary events the server sends you. */
  incoming?: Record<string, unknown>;
  /** Binary events you send the server. */
  outgoing?: Record<string, unknown>;
  clientRequests?: Record<string, RequestContract>;
  serverRequests?: Record<string, RequestContract>;
  streams?: Record<string, StreamContract>;
}

/**
 * The events for one channel. Each scope has its own events, so the same name
 * (like `'message'`) can mean different things in different scopes.
 */
export interface ScopeContract {
  incoming?: Record<string, unknown>;
  outgoing?: Record<string, unknown>;
  clientRequests?: Record<string, RequestContract>;
  serverRequests?: Record<string, RequestContract>;
  streams?: Record<string, StreamContract>;
  binary?: BinaryContract;
}

/** A channel uses the same shape as any scope. */
export type ChannelContract = ScopeContract;

/** One request/response pair: `payload` is what you send, `response` is what comes back. */
export interface RequestContract {
  payload: unknown;
  response: unknown;
}

/**
 * One streaming definition: `payload` starts the stream, `chunk` is the shape
 * of each piece you receive, `kind` marks a durable (`'persistent'`) stream you
 * can continue versus a plain (`'ephemeral'`) one, and `nudges` (optional) are
 * messages you can send to a running stream.
 */
export interface StreamContract {
  payload: unknown;
  chunk: unknown;
  kind?: 'ephemeral' | 'persistent';
  nudges?: Record<string, unknown>;
}

/** Pull one key out of a contract, or fall back to `{}` if it's missing. */
export type IncomingOf<T> = T extends { incoming: infer I } ? I : {};
export type OutgoingOf<T> = T extends { outgoing: infer O } ? O : {};
export type ChannelsOf<T> = T extends { channels: infer C } ? C : {};
export type StreamsOf<T> = T extends { streams: infer S } ? S : {};
export type ClientRequestsOf<T> = T extends { clientRequests: infer R } ? R : {};
export type ServerRequestsOf<T> = T extends { serverRequests: infer R } ? R : {};
export type ErrorsOf<T> = T extends { errors: infer E } ? E : {};
export type BinaryOf<T> = T extends { binary: infer B } ? B : {};

/**
 * The four connection states:
 * - `closed` — not connected and not trying
 * - `connecting` — opening a connection
 * - `open` — connected and ready
 * - `reconnecting` — dropped, waiting to retry
 */
export type ConnectionState = 'closed' | 'connecting' | 'open' | 'reconnecting';

/**
 * Connection quality from ping/pong latency:
 * - `excellent` under 100ms, `good` 100–300ms, `degraded` 300–1000ms
 * - `poor` at 1000ms or more, or after a missed pong
 * - `disconnected` when the socket isn't open
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';

/** Flatten an intersection into one object so editor tooltips read cleanly. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Options for one `nudge()` call. */
interface NudgeOptions {
  /** How long to wait for the server to confirm the nudge, in ms. */
  timeout?: number;
}

/**
 * The handle `stream()` returns: an async iterable of chunks you can also nudge
 * or cancel. Breaking out of a `for await` loop cancels it for you.
 */
export interface StreamHandle<TChunks, TNudges = {}> extends AsyncIterable<TChunks> {
  /**
   * Send a mid-stream message to the running server generator. The Promise
   * resolves when the server confirms the nudge (`__nudgeOk__`) and rejects if
   * it's refused or `nudgeTimeout` elapses — a rejected nudge does not end the
   * stream. After the stream ends, a nudge resolves to a no-op. A nudge
   * declared with no payload is sent with just its name: `nudge('pause')`.
   */
  nudge<K extends keyof TNudges & string>(
    event: K,
    ...args: undefined extends TNudges[K]
      ? [payload?: TNudges[K], options?: NudgeOptions]
      : [payload: TNudges[K], options?: NudgeOptions]
  ): Promise<void>;
  /** Ask the server to stop. The loop exits without throwing. */
  cancel(): void;
  /** The id that groups this stream's chunks. */
  readonly streamId: string;
  /** Whether the stream is still running. */
  readonly active: boolean;
}

/** Callbacks for a listen-only (broadcast) stream via `onStream()`. */
export interface StreamHandlers<TChunk> {
  /** A chunk arrived. */
  onChunk(chunk: TChunk, streamId: string): void;
  /** The stream finished. `finalSeq` is the last `seq`, to detect missed chunks. */
  onEnd?(streamId: string, finalSeq?: number): void;
  /** The stream errored. Every subscriber on a broadcast stream is notified. */
  onError?(error: LiveThingError, streamId: string): void;
  /** No chunk arrived within the per-chunk timeout. */
  onTimeout?(streamId: string): void;
}

/** Pull the `nudges` map out of one stream definition, or `{}` if it has none. */
export type NudgesOf<S> = S extends { nudges: infer N } ? N : {};

/**
 * The stream names whose `kind` is `'persistent'` — the only streams you can
 * continue. A plain (`'ephemeral'`) stream is not a valid `continueStream()` argument.
 */
export type PersistentStreamKeys<S> = {
  [K in keyof S]: S[K] extends { kind: 'persistent' } ? K : never;
}[keyof S];

/** Adds a `request()`-style method typed from the contract's `clientRequests`. */
export type RequestMethod<TContract, TMethod extends string> = TContract extends {
  clientRequests: infer R extends Record<string, { payload: any; response: any }>;
}
  ? {
      [M in TMethod]: <K extends keyof R & string>(
        event: K,
        payload: R[K]['payload'],
        options?: { timeout?: number },
      ) => Promise<R[K]['response']>;
    }
  : {};

/**
 * What an `onGap` callback receives. `missedThrough` is the highest sequence
 * number the server dropped from retention — anything you hadn't seen at or
 * below it is gone. `channel` / `channelFamily` are set on a channel gap and
 * absent on a top-level one.
 */
export interface GapInfo {
  channel?: string;
  channelFamily?: string;
  missedThrough: number;
}

/**
 * The full messaging type for one scope (a channel): `on`/`send`
 * plus `request()` when the scope has client requests, and the stream methods
 * when it has streams.
 */

export type ScopedMessaging<C> = Messaging<IncomingOf<C> & object, OutgoingOf<C> & object> &
  (C extends { clientRequests: infer R extends Record<string, { payload: any; response: any }> }
    ? {
        request<E extends keyof R & string>(
          event: E,
          payload: R[E]['payload'],
          options?: { timeout?: number },
        ): Promise<R[E]['response']>;
      }
    : {}) &
  (C extends { serverRequests: infer SR extends Record<string, { payload: any; response: any }> }
    ? {
        onRequest<E extends keyof SR & string>(
          event: E,
          handler: (payload: SR[E]['payload']) => SR[E]['response'] | Promise<SR[E]['response']>,
        ): () => void;
      }
    : {}) &
  (C extends { streams: infer S extends Record<string, { payload: any; chunk: any }> }
    ? {
        stream<E extends keyof S & string>(
          event: E,
          payload: S[E]['payload'],
          options?: { streamId?: string },
        ): Promise<StreamHandle<S[E]['chunk'], NudgesOf<S[E]>>>;
        onStream<E extends keyof S & string>(
          event: E,
          handlers: StreamHandlers<S[E]['chunk']>,
        ): () => void;
        continueStream<E extends PersistentStreamKeys<S> & string>(
          event: E,
          streamId: string,
          options?: { lastKnownSeq?: number },
        ): StreamHandle<S[E]['chunk'], NudgesOf<S[E]>>;
      }
    : {});

/**
 * Turns a contract key holding many scopes into a lookup method. For example
 * `ScopedApi<C, 'channels', 'channel'>` produces
 * `channel(name): ScopedMessaging` typed for each name.
 */
export type ScopedApi<TContract, TKey extends string, TMethod extends string> =
  TContract extends Record<TKey, infer Map extends Record<string, any>>
    ? { [M in TMethod]: <K extends keyof Map & string>(name: K) => ScopedMessaging<Map[K]> }
    : {};
