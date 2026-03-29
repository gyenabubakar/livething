/* oxlint-disable @typescript-eslint/no-explicit-any -- Requires uses `any` intentionally for loose contract matching */
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
