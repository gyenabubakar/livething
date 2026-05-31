import type { WireMessage } from '~/internal/runtime.ts';

// ---------------------------------------------------------------------------
// Internal resolved config bag
// ---------------------------------------------------------------------------
//
// Primitives are syntactic sugar over this flat config. `client()` collects
// the primitive descriptors and merges them into one `SocketConfig`, which the
// Socket and its sub-managers (reconnection, keepalive, buffer) consume.

/** Quality latency thresholds (upper bounds, in ms). */
export interface QualityThresholds {
  excellent: number;
  good: number;
  degraded: number;
}

/** The fully-resolved internal config the Socket runs on. */
export interface SocketConfig {
  // ── connect ──
  url: string | (() => string | Promise<string>);
  lazy?: boolean;
  /** Idle disconnect timeout in lazy mode (ms). `0` disables. Default: 10_000. */
  idleTimeout?: number;
  protocols?: string[];

  // ── reconnection ──
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  maxReconnectDelay?: number;
  shouldReconnect?: (code: number, reason: string) => boolean | void;
  nonRetryableCodes?: number[];
  networkAware?: boolean;

  // ── keepalive ──
  pingInterval?: number;
  maxMissedPongs?: number;
  qualityThresholds?: QualityThresholds;

  // ── buffering ──
  bufferEnabled?: boolean;
  maxBufferSize?: number;
  bufferTTL?: number | Record<string, number>;
  flushInterval?: number;

  // ── query ──
  searchParams?: () => Record<string, string> | Promise<Record<string, string>>;

  // ── serialization ──
  binaryType?: 'arraybuffer' | 'blob';
  parseBinary?: (data: unknown) => WireMessage | null;
  parse?: (raw: string) => WireMessage | null;
  serialize?: (message: WireMessage) => string;

  // ── debug ──
  debug?: boolean;
}
