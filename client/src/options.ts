/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin array typing requires `any` */
import type { PlatformAdapter } from '~/adapter.ts';
import type { Plugin } from '~/plugins/base.ts';
import type { SocketContract } from '~/types.ts';

// ---------------------------------------------------------------------------
// Socket options
// ---------------------------------------------------------------------------

/** Options for `createSocket`. All options are optional. */
export interface SocketOptions<_TContract extends SocketContract = SocketContract> {
  /** Override platform detection. Web APIs (visibility, network) are auto-detected — only needed for React Native (`@wskit/client-react-native`) or custom platforms (Electron, Capacitor). */
  adapter?: PlatformAdapter;

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

// ---------------------------------------------------------------------------
// Binary options (linked pair)
// ---------------------------------------------------------------------------

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
