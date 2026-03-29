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

/** The event object passed to `onClose` handlers. */
export interface CloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** A parsed message as seen by middleware. */
export interface MiddlewareMessage {
  event: string;
  payload: unknown;
}

/** Middleware function signature. Return the message, a modified message, or `null` to drop. */
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

  /** Close the connection and tear down the socket. */
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

  /** Listen for incoming events. Typed against `TContract['incoming']`. */
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

  /** Send raw binary data. Not typed against `outgoing`. */
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

  /** Fires when connection quality changes tier. */
  onQualityChange(_callback: (quality: ConnectionQuality, latency: number) => void): () => void {
    throw new Error('Not implemented');
  }

  // ── Middleware ────────────────────────────────────────────────

  /** Add incoming message middleware. Runs in registration order. */
  use(_middleware: MiddlewareFn): void {
    throw new Error('Not implemented');
  }

  // ── Debug ────────────────────────────────────────────────────

  /** Toggle debug logging at runtime. */
  setDebug(_enabled: boolean): void {
    throw new Error('Not implemented');
  }
}

// ---------------------------------------------------------------------------
// createSocket
// ---------------------------------------------------------------------------

/** Options for `createSocket`. All options are optional. */
export interface SocketOptions<_TContract extends SocketContract = SocketContract> {
  /** Platform adapter for visibility and network detection. */
  adapter?: unknown;

  /** Plugins that add server-dependent features. */
  plugins?: readonly Plugin<any, any>[];

  /** Whether to reconnect automatically when the connection drops. Default: `true`. */
  reconnect?: boolean;

  /** Maximum reconnection attempts before giving up. Default: `10`. */
  maxReconnectAttempts?: number;

  /** Maximum delay between reconnection attempts in ms. Default: `30000`. */
  maxReconnectDelay?: number;

  /** Callback to decide whether to reconnect after a close. */
  shouldReconnect?: (code: number, reason: string) => boolean | void;

  /** Close codes that should not trigger reconnection. */
  nonRetryableCodes?: number[];

  /** Don't connect until something needs the connection. Default: `false`. */
  lazy?: boolean;

  /** How long to wait with no activity before disconnecting in lazy mode. Default: `10000`. */
  lazyIdleTimeout?: number;

  /** Subprotocols to pass to the WebSocket constructor. */
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

  /** Per-event TTL for buffered top-level messages. */
  bufferTTL?: number | Record<string, number>;

  /** Milliseconds between each buffered message flush on reconnect. Default: `0`. */
  flushInterval?: number;

  /** Pause reconnection when the device is offline. Default: `true`. */
  networkAware?: boolean;

  /** Disconnect after this many ms of inactivity. `0` to disable. Default: `0`. */
  inactiveTimeout?: number;

  /** Override connection quality thresholds. */
  qualityThresholds?: { excellent: number; good: number; degraded: number };

  /** Search params appended to the URL on every connect/reconnect. */
  searchParams?: () => URLSearchParams | Promise<URLSearchParams>;

  /** Custom message parser. Return `{ event, payload }` or `null` to skip. */
  parse?: (raw: string) => { event: string; payload: unknown } | null;

  /** Custom message serializer. */
  serialize?: (event: string, payload: unknown) => string;

  /** Log every internal event to the console. Default: `false`. */
  debug?: boolean;
}

// Binary options are linked — both or neither.
interface BinaryOptionsArrayBuffer {
  binaryType: 'arraybuffer';
  parseBinary: (data: ArrayBuffer) => { event: string; payload: unknown } | null;
}

interface BinaryOptionsBlob {
  binaryType: 'blob';
  parseBinary: (data: Blob) => { event: string; payload: unknown } | null;
}

/** Full options type with linked binary options. */
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
