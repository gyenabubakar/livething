/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin type merging requires `any` */
import type { SendOptions } from '@/endpoint.ts';
import type { Plugin } from '@/plugins/base.ts';
import type { ApplyPlugins, ValidatePlugins } from '@/plugins/types.ts';
import type {
  ConnectionQuality,
  ConnectionState,
  IncomingOf,
  OutgoingOf,
  Simplify,
  SocketContract,
} from '@/types.ts';

// ---------------------------------------------------------------------------
// Close event
// ---------------------------------------------------------------------------

/**
 * Describes a WebSocket close, passed to `onClose` handlers.
 *
 * - `code` — numeric close code (e.g., 1000 = normal, 1006 = abnormal, 4001 = app-defined)
 * - `reason` — optional string from the server (e.g., "token expired")
 * - `wasClean` — `true` if the close handshake completed properly
 */
export interface CloseEvent {
  /** WebSocket close code (e.g., 1000 for normal, 4001 for app-defined). */
  code: number;
  /** Optional close reason from the server. */
  reason: string;
  /** Whether the close handshake completed properly. */
  wasClean: boolean;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * A deserialized incoming message. Middleware receives this and can
 * inspect, modify, or drop it before it reaches event handlers.
 */
export interface MiddlewareMessage {
  /** The event name (e.g., `'notification'`, `'chat-message'`). */
  event: string;
  /** The event payload, already parsed from the wire format. */
  payload: unknown;
}

/**
 * Middleware function. Called in registration order for each incoming message.
 *
 * - Return nothing (or `undefined`) → message passes through unchanged
 * - Return a new `{ event, payload }` → replaces the original message
 * - Return `null` → message is dropped, no handlers fire
 */
export type MiddlewareFn = (message: MiddlewareMessage) => MiddlewareMessage | null | void;

// ---------------------------------------------------------------------------
// Socket class
// ---------------------------------------------------------------------------

/**
 * The core WebSocket client. Handles connection lifecycle, reconnection,
 * keepalive, buffering, middleware, and event dispatch. Plugin APIs are
 * merged onto the type by `createSocket`.
 *
 * Developers never instantiate this directly — use `createSocket()`.
 */
export class Socket<TContract extends SocketContract> {
  /** The underlying native WebSocket instance. `null` when disconnected. */
  readonly ws: WebSocket | null = null;

  /** The subprotocol selected by the server during handshake. `null` if none. */
  readonly protocol: string | null = null;

  /** Open the WebSocket connection. Safe to call multiple times. */
  connect(): void {
    throw new Error('Not implemented');
  }

  /**
   * Close the connection and fully tear down the socket.
   *
   * Stops reconnection, clears the message buffer, rejects all pending
   * `request()` and `send.withAck()` promises, and detaches platform listeners.
   * All `.on()` handlers remain registered — call `connect()` to reconnect.
   *
   * @param _code WebSocket close code. Default: `1000` (normal closure).
   * @param _reason Close reason string sent to the server. Default: `''`.
   */
  disconnect(_code?: number, _reason?: string): void {
    throw new Error('Not implemented');
  }

  /** Current connection state. */
  getState(): ConnectionState {
    throw new Error('Not implemented');
  }

  /** Current connection quality based on ping latency. */
  getQuality(): ConnectionQuality {
    throw new Error('Not implemented');
  }

  /** Last measured round-trip time in milliseconds, or `null` if unknown. */
  getLatency(): number | null {
    throw new Error('Not implemented');
  }

  /**
   * Subscribe to state changes. The callback receives no arguments —
   * read the new state with `getState()`. Returns an unsubscribe function.
   */
  subscribe(_callback: () => void): () => void {
    throw new Error('Not implemented');
  }

  // ── Event callbacks ──────────────────────────────────────────

  /** Listen for incoming events. Typed against `TContract['incoming']`. Returns an unsubscribe function. */
  on<K extends keyof IncomingOf<TContract> & string>(
    _event: K,
    _handler: (data: IncomingOf<TContract>[K]) => void,
  ): () => void {
    throw new Error('Not implemented');
  }

  /** Send an outgoing event. Typed against `TContract['outgoing']`. Returns `true` if sent or buffered. */
  send<K extends keyof OutgoingOf<TContract> & string>(
    _event: K,
    _payload: OutgoingOf<TContract>[K],
    _options?: SendOptions,
  ): boolean {
    throw new Error('Not implemented');
  }

  /**
   * Send raw binary data directly over the WebSocket. Bypasses the `serialize`
   * option and contract typing — you handle the encoding.
   */
  sendBinary(_data: ArrayBuffer | ArrayBufferView | Blob): void {
    throw new Error('Not implemented');
  }

  // ── Lifecycle callbacks ──────────────────────────────────────

  /** Fires on every connection open (first connect and reconnects). */
  onOpen(_callback: () => void): () => void {
    throw new Error('Not implemented');
  }

  /** Fires only on reconnects (not the first connect). */
  onReconnect(_callback: () => void): () => void {
    throw new Error('Not implemented');
  }

  /** Fires when all reconnection attempts are exhausted. */
  onReconnectFailed(_callback: () => void): () => void {
    throw new Error('Not implemented');
  }

  /** Fires on every WebSocket close, including closes that trigger reconnection. */
  onClose(_callback: (event: CloseEvent) => void): () => void {
    throw new Error('Not implemented');
  }

  /** Fires on WebSocket protocol errors. Not called on normal disconnection. */
  onError(_callback: (error: Event) => void): () => void {
    throw new Error('Not implemented');
  }

  /**
   * Fires when connection quality transitions between tiers
   * (e.g., `'good'` → `'degraded'`). Callback receives the new quality
   * tier and the current round-trip latency in milliseconds.
   */
  onQualityChange(_callback: (quality: ConnectionQuality, latency: number) => void): () => void {
    throw new Error('Not implemented');
  }

  // ── Middleware ────────────────────────────────────────────────

  /** Add incoming message middleware. Runs in registration order. */
  use(_middleware: MiddlewareFn): void {
    throw new Error('Not implemented');
  }

  // ── Debug ────────────────────────────────────────────────────

  /** Enable or disable console debug logging for connection events, message flow, and plugin activity. */
  setDebug(_enabled: boolean): void {
    throw new Error('Not implemented');
  }
}

// ---------------------------------------------------------------------------
// createSocket
// ---------------------------------------------------------------------------

/** Options for `createSocket`. All options are optional. */
export interface SocketOptions<_TContract extends SocketContract = SocketContract> {
  /** Adapter for platform-specific behavior (browser tab visibility, network online/offline). Use `Adapter` from `@better-websocket/client-web` or `@better-websocket/client-react-native`. */
  adapter?: unknown;

  /** Plugin instances that extend socket functionality (e.g., Channels, RequestResponse, Ack, Stream). Each plugin can add methods, intercept messages, and hook into the connection lifecycle. */
  plugins?: readonly Plugin<any, any>[];

  /** Whether to reconnect automatically when the connection drops. Default: `true`. */
  reconnect?: boolean;

  /** Maximum reconnection attempts before giving up. Default: `10`. */
  maxReconnectAttempts?: number;

  /** Maximum delay between reconnection attempts in ms. Default: `30000`. */
  maxReconnectDelay?: number;

  /** Callback to decide whether to reconnect after a close. Return `true` to force reconnect, `false` to suppress, `undefined` to fall through to `nonRetryableCodes` / default behavior. */
  shouldReconnect?: (code: number, reason: string) => boolean | void;

  /** Close codes that should not trigger reconnection. */
  nonRetryableCodes?: number[];

  /** Delay connection until the first `on()`, `send()`, `request()`, or `send.withAck()` call. Default: `false`. */
  lazy?: boolean;

  /** How long to wait with no activity before disconnecting in lazy mode. Default: `10000`. */
  lazyIdleTimeout?: number;

  /** WebSocket subprotocol strings (e.g., `['graphql-ws']`). The server selects one — check `socket.protocol` after connecting. */
  protocols?: string[];

  /** How often to send a keepalive ping in ms. `0` to disable. Default: `30000`. */
  pingInterval?: number;

  /** The string to send as a ping. Default: `'ping'`. */
  pingMessage?: string;

  /** The string the server replies with. Default: `'pong'`. */
  pongMessage?: string;

  /** Consecutive missed pongs before force-closing. Default: `2`. */
  maxMissedPongs?: number;

  /** Queue outgoing messages while disconnected. Default: `false`. */
  bufferWhileDisconnected?: boolean;

  /** Maximum buffered messages. Oldest dropped when full. Default: `50`. */
  maxBufferSize?: number;

  /** Time-to-live for buffered messages. A number applies to all events; a record maps event names to individual TTLs. Messages exceeding their TTL are silently dropped on flush. */
  bufferTTL?: number | Record<string, number>;

  /** Milliseconds between each buffered message flush on reconnect. Default: `0`. */
  flushInterval?: number;

  /** Pause reconnection when the device is offline. Default: `true`. */
  networkAware?: boolean;

  /** Disconnect after this many ms of inactivity. `0` to disable. Default: `0`. */
  inactiveTimeout?: number;

  /** Latency thresholds in ms for quality tiers. Values are upper bounds: `{ excellent: 100, good: 300, degraded: 1000 }`. Everything above `degraded` is `'poor'`. */
  qualityThresholds?: { excellent: number; good: number; degraded: number };

  /** Function returning query params to append to the WebSocket URL on every connect/reconnect. Can be async (e.g., to refresh auth tokens). */
  searchParams?: () => URLSearchParams | Promise<URLSearchParams>;

  /** Custom message parser. Return `{ event, payload }` or `null` to skip. */
  parse?: (raw: string) => { event: string; payload: unknown } | null;

  /** Custom message serializer. Receives `(event, payload)` and returns the string to send over the wire. Inverse of `parse`. Default: `JSON.stringify({ event, payload })`. */
  serialize?: (event: string, payload: unknown) => string;

  /** Log every internal event to the console. Default: `false`. */
  debug?: boolean;
}

/**
 * Binary message handling with ArrayBuffer format.
 * Both `binaryType` and `parseBinary` must be provided together — one without the other is a type error.
 */
interface BinaryOptionsArrayBuffer {
  /** Receive binary data as `ArrayBuffer`. */
  binaryType: 'arraybuffer';
  /** Parse binary data into `{ event, payload }`. Return `null` to skip the message. */
  parseBinary: (data: ArrayBuffer) => { event: string; payload: unknown } | null;
}

/**
 * Binary message handling with Blob format.
 * Both `binaryType` and `parseBinary` must be provided together — one without the other is a type error.
 */
interface BinaryOptionsBlob {
  /** Receive binary data as `Blob`. */
  binaryType: 'blob';
  /** Parse binary data into `{ event, payload }`. Return `null` to skip the message. */
  parseBinary: (data: Blob) => { event: string; payload: unknown } | null;
}

/**
 * Complete socket options. Extends `SocketOptions` with linked binary options:
 * provide both `binaryType` and `parseBinary`, or neither. Providing one
 * without the other is a type error.
 */
export type FullSocketOptions<TContract extends SocketContract> = SocketOptions<TContract> &
  (BinaryOptionsArrayBuffer | BinaryOptionsBlob | {});

/**
 * Create a typed WebSocket client.
 *
 * ```ts
 * const socket = createSocket<MySocket>('wss://example.com/ws', {
 *   adapter: new Adapter(),
 *   plugins: [new Channels(), new RequestResponse()],
 * });
 * ```
 */
export declare function createSocket<
  TContract extends SocketContract,
  const TPlugins extends readonly Plugin<any, any>[] = [],
>(
  url: string | (() => string | Promise<string>),
  options?: FullSocketOptions<TContract> & {
    plugins?: ValidatePlugins<TContract, TPlugins> & TPlugins;
  },
): Simplify<Socket<TContract> & ApplyPlugins<TPlugins, TContract>>;
