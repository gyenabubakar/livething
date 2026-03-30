/* oxlint-disable @typescript-eslint/no-explicit-any -- Requires uses `any` intentionally for loose contract matching */
import type { Endpoint } from '@/endpoint.ts';

// ---------------------------------------------------------------------------
// Socket contract
// ---------------------------------------------------------------------------

/**
 * The shape a user defines to type their socket. Every key is optional —
 * omitting a key removes the corresponding API surface at compile time.
 *
 * ```ts
 * interface MySocket {
 *   incoming: { notification: { title: string } };
 *   outgoing: { 'mark-read': { id: string } };
 *   channels: { chat: { incoming: { message: { text: string } } } };
 *   requests: { 'get-balance': { payload: { userId: string }; response: { balance: number } } };
 * }
 * ```
 */
export interface SocketContract {
  incoming?: Record<string, unknown>;
  outgoing?: Record<string, unknown>;
  channels?: Record<string, ChannelContract>;
  requests?: Record<string, RequestContract>;
}

/**
 * A channel's type definition. Each channel has its own incoming/outgoing
 * events and requests, separate from the top-level socket events. This lets
 * the same event name (e.g., `'message'`) have different payload types in
 * different channels.
 */
export interface ChannelContract {
  incoming?: Record<string, unknown>;
  outgoing?: Record<string, unknown>;
  requests?: Record<string, RequestContract>;
}

/**
 * A request-response pair. `payload` is what the client sends, `response` is
 * what the server replies with. Used by the `RequestResponse` plugin to type
 * `socket.request(event, payload): Promise<response>`.
 */
export interface RequestContract {
  payload: unknown;
  response: unknown;
}

// ---------------------------------------------------------------------------
// Contract extractors
// ---------------------------------------------------------------------------

/** Pull `incoming` from a contract, or `{}` if absent. */
export type IncomingOf<T> = T extends { incoming: infer I } ? I : {};

/** Pull `outgoing` from a contract, or `{}` if absent. */
export type OutgoingOf<T> = T extends { outgoing: infer O } ? O : {};

/** Pull `channels` from a contract, or `{}` if absent. */
export type ChannelsOf<T> = T extends { channels: infer C } ? C : {};

/** Pull `requests` from a contract, or `{}` if absent. */
export type RequestsOf<T> = T extends { requests: infer R } ? R : {};

// ---------------------------------------------------------------------------
// Requires — lets plugins declare what they need from the contract
// ---------------------------------------------------------------------------

/**
 * Builds a constraint type from event name lists. If a plugin uses
 * `Requires<{ incoming: ['user-joined'] }>`, the socket contract must
 * have `incoming: { 'user-joined': any }` or TypeScript errors at the
 * `plugins` array.
 */
export type Requires<
  R extends {
    incoming?: string[];
    outgoing?: string[];
    channels?: string[];
    requests?: string[];
  },
> = (R['incoming'] extends string[] ? { incoming: Record<R['incoming'][number], any> } : {}) &
  (R['outgoing'] extends string[] ? { outgoing: Record<R['outgoing'][number], any> } : {}) &
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
 * - `'excellent'` — latency under 100ms (configurable)
 * - `'good'` — latency 100–300ms
 * - `'degraded'` — latency 300–1000ms
 * - `'poor'` — latency over 1000ms or missed pongs
 * - `'disconnected'` — socket is not open
 */
export type ConnectionQuality = 'excellent' | 'good' | 'degraded' | 'poor' | 'disconnected';

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Flatten intersections into a single object for readable editor tooltips. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Shorthand for plugins whose API does not depend on the contract.
 *
 * ```ts
 * class Metrics extends Plugin<StaticApi<{ getCount(event: string): number }>> { ... }
 * ```
 */
export type StaticApi<Api> = {
  readonly _contract: unknown;
  readonly _api: Api;
};

// ---------------------------------------------------------------------------
// Plugin type function utilities
// ---------------------------------------------------------------------------

/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin type utilities require `any` for generic matching */

/**
 * A method typed against `outgoing` events. Produces `{ method(event, payload): Return }`
 * when the contract has outgoing events, `{}` otherwise.
 *
 * ```ts
 * interface BroadcastTypeFn extends TypeFn {
 *   readonly _api: OutgoingMethod<this['_contract'], 'broadcast', void>;
 * }
 * ```
 */
export type OutgoingMethod<
  TContract,
  TMethod extends string,
  TReturn = boolean,
> = TContract extends { outgoing: infer O extends Record<string, any> }
  ? { [M in TMethod]: <K extends keyof O & string>(event: K, payload: O[K]) => TReturn }
  : {};

/**
 * A method typed against `incoming` events. Produces `{ method(event, handler): unsubscribe }`
 * when the contract has incoming events, `{}` otherwise.
 *
 * ```ts
 * interface TapTypeFn extends TypeFn {
 *   readonly _api: IncomingMethod<this['_contract'], 'tap'>;
 * }
 * ```
 */
export type IncomingMethod<TContract, TMethod extends string> = TContract extends {
  incoming: infer I extends Record<string, any>;
}
  ? {
      [M in TMethod]: <K extends keyof I & string>(
        event: K,
        handler: (data: I[K]) => void,
      ) => () => void;
    }
  : {};

/**
 * A method typed against `requests`. Produces `{ method(event, payload, options?): Promise<response> }`
 * when the contract has requests, `{}` otherwise.
 *
 * ```ts
 * interface QueryTypeFn extends TypeFn {
 *   readonly _api: RequestMethod<this['_contract'], 'query'>;
 * }
 * ```
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
 * Full endpoint type for a scoped contract (channel, room, topic, etc.).
 * Includes `on()` + `send()` from `Endpoint`, plus `request()` if the scope
 * has `requests`, and `send.withAck()` if the scope has `outgoing`.
 *
 * ```ts
 * type ChatEndpoint = ScopedEndpoint<MySocket['channels']['chat']>;
 * ```
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
 * One-liner for scoped plugins (channels, rooms, topics). Given a contract key
 * containing a named map of scoped contracts, produces a method that returns
 * a fully-typed `ScopedEndpoint` for each name.
 *
 * ```ts
 * interface ChannelsTypeFn extends TypeFn {
 *   readonly _api: ScopedApi<this['_contract'], 'channels', 'channel'>;
 * }
 *
 * interface RoomsTypeFn extends TypeFn {
 *   readonly _api: ScopedApi<this['_contract'], 'rooms', 'room'>;
 * }
 * ```
 */
export type ScopedApi<TContract, TKey extends string, TMethod extends string> =
  TContract extends Record<TKey, infer Map extends Record<string, any>>
    ? { [M in TMethod]: <K extends keyof Map & string>(name: K) => ScopedEndpoint<Map[K]> }
    : {};
