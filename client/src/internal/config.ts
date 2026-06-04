import type { InterceptFn, WireMessage } from '~/internal/runtime.ts';

/** Latency cut-offs (ms) for each quality tier. */
export interface QualityThresholds {
  excellent: number;
  good: number;
  degraded: number;
}

/**
 * The settings the kernel runs on. It only holds kernel-level things and the few
 * values shared between primitives (like quality thresholds, which `quality()`
 * sets and `keepalive()` reads). Anything specific to one behavior — backoff,
 * ping interval, buffer size — lives inside that primitive, not here, so its
 * code only loads when you use it.
 */
export interface SocketConfig {
  /** The URL, or a function that returns one on every connect/reconnect. */
  url: string | (() => string | Promise<string>);
  /** Wait to connect until something needs the socket. */
  lazy?: boolean;
  /** In lazy mode, close after this many ms of no use. `0` means never. Default: 10_000. */
  idleTimeout?: number;
  /** WebSocket subprotocols. */
  protocols?: string[];

  /** Set by `quality()`, read by `keepalive()`. */
  qualityThresholds?: QualityThresholds;

  /** Returns query params to add to the URL on every connect/reconnect. */
  searchParams?: () => Record<string, string> | Promise<Record<string, string>>;

  /** Format the server delivers binary frames in. */
  binaryType?: 'arraybuffer' | 'blob';
  /** Decode a binary frame into a message, or `null` to ignore it. */
  parseBinary?: (data: unknown) => WireMessage | null;
  /** Decode a text frame into a message, or `null` to ignore it. */
  parse?: (raw: string) => WireMessage | null;
  /** Encode a message into the string sent over the wire. */
  serialize?: (message: WireMessage) => string;

  /** Functions that get to inspect/transform/drop each incoming message. */
  intercepts?: InterceptFn[];

  /** Log connection events and message flow to the console. */
  debug?: boolean;
}
