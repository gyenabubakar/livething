/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin type merging requires `any` */
import type { SendOptions } from '@/endpoint.ts';
import type { FullSocketOptions } from '@/options.ts';
import type { Plugin } from '@/plugins/base.ts';
import type {
  ConnectionQuality,
  ConnectionState,
  IncomingOf,
  OutgoingOf,
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

  /** @internal */
  _url: string | (() => string | Promise<string>);
  /** @internal */
  _options: FullSocketOptions<TContract>;
  /** @internal */
  _plugins: readonly Plugin<any, any>[];
  /** @internal */
  _state: ConnectionState = 'closed';

  /** @internal */
  constructor(
    url: string | (() => string | Promise<string>),
    options: FullSocketOptions<TContract>,
    plugins: readonly Plugin<any, any>[],
  ) {
    this._url = url;
    this._options = options;
    this._plugins = plugins;
  }

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
    return this._state;
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
