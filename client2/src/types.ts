/* oxlint-disable @typescript-eslint/no-explicit-any -- Requires/type-fns use `any` intentionally for loose contract matching */
import type { Endpoint } from '~/endpoint.ts';

// ---------------------------------------------------------------------------
// Socket contract
// ---------------------------------------------------------------------------

/**
 * The shape a user defines to type their socket. Every key is optional —
 * omitting a key removes the corresponding API surface at compile time.
 *
 * `incoming` and `outgoing` are always from the perspective of whoever holds
 * the type: the server's `outgoing` becomes the client's `incoming`.
 *
 * ```ts
 * interface MySocket {
 *   incoming: { notification: { title: string } };
 *   outgoing: { 'mark-read': { id: string } };
 *   namespaces: { notifications: { incoming: { alert: { message: string } } } };
 *   channels: { chat: { incoming: { message: { text: string } } } };
 *   streams: { 'ask-ai': { payload: { prompt: string }; chunks: { text: string } } };
 *   requests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
 *   errors: { forbidden: { reason: string } };
 * }
 * ```
 */
export interface SocketContract {
  /** Events the server sends to the client (top-level, not in a namespace or channel). */
  incoming?: Record<string, unknown>;
  /** Events the client sends to the server (top-level, not in a namespace or channel). */
  outgoing?: Record<string, unknown>;
  /** Named namespaces — routing only, no server state. Requires the `namespaces` primitive. */
  namespaces?: Record<string, ScopeContract>;
  /** Server-managed rooms requiring `subscribe()`. Requires the `channels` primitive. */
  channels?: Record<string, ScopeContract>;
  /** Streaming event pairs. Requires the `stream` primitive. */
  streams?: Record<string, StreamContract>;
  /** Request-response pairs with typed responses. Requires the `requestResponse` primitive. */
  requests?: Record<string, RequestContract>;
  /** Typed application errors from the server, enabling `ErrorDef.matches(err)` narrowing. */
  errors?: Record<string, unknown>;
}

/**
 * A namespace's or channel's type definition. Each scope has its own
 * incoming/outgoing events, requests, and optionally streams — separate from
 * the top-level socket events. This lets the same event name (e.g.,
 * `'message'`) have different payload types in different scopes.
 */
export interface ScopeContract {
  incoming?: Record<string, unknown>;
  outgoing?: Record<string, unknown>;
  requests?: Record<string, RequestContract>;
  streams?: Record<string, StreamContract>;
}

/** Backwards-friendly alias — a channel uses the same shape as any scope. */
export type ChannelContract = ScopeContract;

/**
 * A request-response pair. `payload` is what the client sends, `response` is
 * what the server replies with.
 */
export interface RequestContract {
  payload: unknown;
  response: unknown;
}

/**
 * A streaming event definition. `payload` triggers the stream, `chunks` is the
 * type of each streamed chunk, and `nudges` (optional) are mid-stream messages
 * the client can send to a running generator.
 */
export interface StreamContract {
  payload: unknown;
  chunks: unknown;
  nudges?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Contract extractors
// ---------------------------------------------------------------------------

/** Pull `incoming` from a contract, or `{}` if absent. */
export type IncomingOf<T> = T extends { incoming: infer I } ? I : {};

/** Pull `outgoing` from a contract, or `{}` if absent. */
export type OutgoingOf<T> = T extends { outgoing: infer O } ? O : {};

/** Pull `namespaces` from a contract, or `{}` if absent. */
export type NamespacesOf<T> = T extends { namespaces: infer N } ? N : {};

/** Pull `channels` from a contract, or `{}` if absent. */
export type ChannelsOf<T> = T extends { channels: infer C } ? C : {};

/** Pull `streams` from a contract, or `{}` if absent. */
export type StreamsOf<T> = T extends { streams: infer S } ? S : {};

/** Pull `requests` from a contract, or `{}` if absent. */
export type RequestsOf<T> = T extends { requests: infer R } ? R : {};

/** Pull `errors` from a contract, or `{}` if absent. */
export type ErrorsOf<T> = T extends { errors: infer E } ? E : {};

// ---------------------------------------------------------------------------
// Requires — lets primitives declare what they need from the contract
// ---------------------------------------------------------------------------

/**
 * Builds a constraint type from event-name lists. If a primitive uses
 * `Requires<{ incoming: ['user-joined'] }>`, the socket contract must have
 * `incoming: { 'user-joined': any }` or TypeScript errors where the primitive
 * is registered.
 *
 * `[number]` turns each array into a union of its elements (the event names).
 * Categories that weren't provided contribute `{}` (no constraint).
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

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

/**
 * The WebSocket connection state.
 *
 * - `'closed'` — not connected, not trying to connect
 * - `'connecting'` — attempting to establish a connection
 * - `'open'` — connected and ready to send/receive
 * - `'reconnecting'` — connection dropped, waiting to retry
 */
export type ConnectionState = 'closed' | 'connecting' | 'open' | 'reconnecting';

/**
 * Connection quality derived from ping/pong latency measurement.
 *
 * - `'excellent'` — latency under 50ms (configurable)
 * - `'good'` — latency 50–150ms
 * - `'degraded'` — latency 150–500ms
 * - `'poor'` — latency over 500ms or 1+ missed pongs
 * - `'disconnected'` — socket is not open
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Flatten intersections into a single object for readable editor tooltips. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Shorthand for primitives whose API does not depend on the contract.
 *
 * ```ts
 * const stream = definePrimitive<StaticApi<{ onStream(...): () => void }>>({ ... });
 * ```
 */
export type StaticApi<Api> = {
  readonly _contract: unknown;
  readonly _api: Api;
};

// ---------------------------------------------------------------------------
// Primitive method utilities (typed against contract slices)
// ---------------------------------------------------------------------------

/**
 * A method typed against `requests`. Produces
 * `{ method(event, payload, options?): Promise<response> }` when the contract
 * has requests, `{}` otherwise.
 */
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
 * Full endpoint type for a scoped contract (namespace, channel, room, etc.).
 * Intersects the base endpoint with conditional `request()` and
 * `send.withAck()` methods.
 *
 * NOTE: extended in later phases with `stream()` and channel membership APIs.
 */
export type ScopedEndpoint<C> = Endpoint<IncomingOf<C> & object, OutgoingOf<C> & object> &
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
        send: {
          withAck<E extends keyof OutgoingOf<C> & string>(
            event: E,
            payload: OutgoingOf<C>[E],
            options?: { timeout?: number; ttl?: number },
          ): Promise<void>;
        };
      });

/**
 * Given a contract key holding a named map of scoped contracts, produces a
 * method that returns a fully-typed `ScopedEndpoint` for each name.
 *
 * The mapped type `[M in TMethod]` creates a computed property name from a
 * string literal — e.g. `TMethod = 'namespace'` produces `{ namespace: ... }`.
 */
export type ScopedApi<TContract, TKey extends string, TMethod extends string> =
  TContract extends Record<TKey, infer Map extends Record<string, any>>
    ? { [M in TMethod]: <K extends keyof Map & string>(name: K) => ScopedEndpoint<Map[K]> }
    : {};
