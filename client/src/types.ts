/* oxlint-disable @typescript-eslint/no-explicit-any -- contract matching is intentionally loose */
import type { WSKitError } from '@wskit/core';
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
 *   requests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
 *   errors: { forbidden: { reason: string } };
 * }
 * ```
 */
export interface SocketContract {
  /** Events the server sends you (top-level, not inside a namespace or channel). */
  incoming?: Record<string, unknown>;
  /** Events you send the server (top-level). */
  outgoing?: Record<string, unknown>;
  /** Named groups of events over the one connection. Needs the `namespaces` primitive. */
  namespaces?: Record<string, ScopeContract>;
  /** Server-managed rooms you subscribe to. Needs the `channels` primitive. */
  channels?: Record<string, ScopeContract>;
  /** Streaming event definitions. Needs the `stream` primitive. */
  streams?: Record<string, StreamContract>;
  /** Request/response pairs. Needs the `requestResponse` primitive. */
  requests?: Record<string, RequestContract>;
  /** Typed errors the server can send, so you can match on them. */
  errors?: Record<string, unknown>;
}

/**
 * The events for one namespace or channel. Each scope has its own events, so the
 * same name (like `'message'`) can mean different things in different scopes.
 */
export interface ScopeContract {
  incoming?: Record<string, unknown>;
  outgoing?: Record<string, unknown>;
  requests?: Record<string, RequestContract>;
  streams?: Record<string, StreamContract>;
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
 * can resume versus a plain (`'ephemeral'`) one, and `nudges` (optional) are
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
export type NamespacesOf<T> = T extends { namespaces: infer N } ? N : {};
export type ChannelsOf<T> = T extends { channels: infer C } ? C : {};
export type StreamsOf<T> = T extends { streams: infer S } ? S : {};
export type RequestsOf<T> = T extends { requests: infer R } ? R : {};
export type ErrorsOf<T> = T extends { errors: infer E } ? E : {};

/**
 * Lets a primitive say which events the contract must have. For example
 * `Requires<{ incoming: ['user-joined'] }>` builds a constraint that the
 * contract's `incoming` includes `'user-joined'`, and TypeScript flags the
 * primitive if it doesn't.
 */
export type Requires<
  R extends {
    incoming?: string[];
    outgoing?: string[];
    namespaces?: string[];
    channels?: string[];
    requests?: string[];
  },
> = (R['incoming'] extends string[] ? { incoming: Record<R['incoming'][number], any> } : {}) &
  (R['outgoing'] extends string[] ? { outgoing: Record<R['outgoing'][number], any> } : {}) &
  (R['namespaces'] extends string[] ? { namespaces: Record<R['namespaces'][number], any> } : {}) &
  (R['channels'] extends string[] ? { channels: Record<R['channels'][number], any> } : {}) &
  (R['requests'] extends string[] ? { requests: Record<R['requests'][number], any> } : {});

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
 * - `excellent` under 50ms, `good` 50–150ms, `degraded` 150–500ms
 * - `poor` over 500ms or after a missed pong
 * - `disconnected` when the socket isn't open
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';

/** Flatten an intersection into one object so editor tooltips read cleanly. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Shorthand for a primitive whose API doesn't depend on the contract. */
export type StaticApi<Api> = {
  readonly _contract: unknown;
  readonly _api: Api;
};

/**
 * The handle `stream()` returns: an async iterable of chunks you can also nudge
 * or cancel. Breaking out of a `for await` loop cancels it for you.
 */
export interface StreamHandle<TChunks, TNudges = {}> extends AsyncIterable<TChunks> {
  /**
   * Send a mid-stream message to the running server generator. The Promise
   * resolves when the server confirms the nudge (`__nudgeOk__`) and rejects if
   * it's refused or `nudgeTimeout` elapses — a rejected nudge does not end the
   * stream. After the stream ends, a nudge resolves to a no-op.
   */
  nudge<K extends keyof TNudges & string>(
    event: K,
    payload: TNudges[K],
    options?: { timeout?: number },
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
  /** The stream errored (only the triggering client sees this on a broadcast). */
  onError?(error: WSKitError, streamId: string): void;
  /** No chunk arrived within the per-chunk timeout. */
  onTimeout?(streamId: string): void;
}

/** Pull the `nudges` map out of one stream definition, or `{}` if it has none. */
export type NudgesOf<S> = S extends { nudges: infer N } ? N : {};

/**
 * The stream names whose `kind` is `'persistent'` — the only streams you can
 * resume. A plain (`'ephemeral'`) stream is not a valid `resumeStream()` argument.
 */
export type PersistentStreamKeys<S> = {
  [K in keyof S]: S[K] extends { kind: 'persistent' } ? K : never;
}[keyof S];

/** Adds a `request()`-style method typed from the contract's `requests`. */
export type RequestMethod<TContract, TMethod extends string> = TContract extends {
  requests: infer R extends Record<string, { payload: any; response: any }>;
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
 * The full messaging type for one scope (a namespace or channel): `on`/`send`
 * plus `request()` when the scope has requests, `sendWithAck()` when it has
 * outgoing events, and the stream methods when it has streams.
 */
export type ScopedMessaging<C> = Messaging<IncomingOf<C> & object, OutgoingOf<C> & object> &
  (C extends { requests: infer R extends Record<string, { payload: any; response: any }> }
    ? {
        request<E extends keyof R & string>(
          event: E,
          payload: R[E]['payload'],
          options?: { timeout?: number },
        ): Promise<R[E]['response']>;
      }
    : {}) &
  (keyof OutgoingOf<C> extends never
    ? {}
    : {
        sendWithAck<E extends keyof OutgoingOf<C> & string>(
          event: E,
          payload: OutgoingOf<C>[E],
          options?: { timeout?: number; ttl?: number },
        ): Promise<void>;
      }) &
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
        resumeStream<E extends PersistentStreamKeys<S> & string>(
          event: E,
          streamId: string,
          options?: { lastKnownSeq?: number },
        ): StreamHandle<S[E]['chunk'], NudgesOf<S[E]>>;
      }
    : {});

/**
 * Turns a contract key holding many scopes into a lookup method. For example
 * `ScopedApi<C, 'namespaces', 'namespace'>` produces
 * `namespace(name): ScopedMessaging` typed for each name.
 */
export type ScopedApi<TContract, TKey extends string, TMethod extends string> =
  TContract extends Record<TKey, infer Map extends Record<string, any>>
    ? { [M in TMethod]: <K extends keyof Map & string>(name: K) => ScopedMessaging<Map[K]> }
    : {};
