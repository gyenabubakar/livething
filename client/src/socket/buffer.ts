import type { SocketOptions } from '~/options.ts';

/** Buffer-relevant subset of SocketOptions. */
export type BufferOptions = Pick<
  SocketOptions,
  'bufferWhileDisconnected' | 'maxBufferSize' | 'bufferTTL' | 'flushInterval'
>;

interface BufferedMessage {
  event: string;
  payload: unknown;
  ttl: number | null;
  queuedAt: number;
}

/**
 * Queues outgoing messages while disconnected, flushes them on reconnect.
 * Supports per-message TTL, max buffer size, and throttled flushing.
 *
 * Internal module — not exported from the package. Used by Socket.
 */
export class MessageBuffer {
  private queue: BufferedMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly enabled: boolean;
  private readonly maxSize: number;
  private readonly ttlConfig: number | Record<string, number> | undefined;
  private readonly flushInterval: number;

  constructor(options: BufferOptions) {
    this.enabled = options.bufferWhileDisconnected ?? false;
    this.maxSize = options.maxBufferSize ?? 50;
    this.ttlConfig = options.bufferTTL;
    this.flushInterval = options.flushInterval ?? 0;
  }

  /**
   * Add a message to the queue. Returns `true` if the message was accepted
   * into the buffer, `false` if buffering is disabled (the message is lost).
   *
   * When the buffer is full (`maxBufferSize`), the oldest message is silently
   * dropped to make room.
   */
  enqueue(event: string, payload: unknown, perCallTtl?: number): boolean {
    if (!this.enabled) return false;

    const ttl = this.resolveTTL(event, perCallTtl);

    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
    }

    this.queue.push({ event, payload, ttl, queuedAt: Date.now() });
    return true;
  }

  /**
   * Send all buffered messages via the provided `send` function.
   *
   * Messages that have exceeded their TTL are silently dropped before
   * sending. When `flushInterval` is `0`, all messages are sent
   * synchronously in order. When `> 0`, one message is sent every
   * `flushInterval` ms (use this to avoid flooding rate-limited servers).
   */
  flush(send: (event: string, payload: unknown) => void, onComplete?: () => void): void {
    this.purgeExpired();

    const messages = this.queue;
    this.queue = [];

    if (messages.length === 0) {
      onComplete?.();
      return;
    }

    if (this.flushInterval <= 0) {
      for (const msg of messages) {
        send(msg.event, msg.payload);
      }
      onComplete?.();
      return;
    }

    let index = 0;
    const tick = (): void => {
      if (index >= messages.length) {
        this.flushTimer = null;
        onComplete?.();
        return;
      }
      const msg = messages[index++]!;
      send(msg.event, msg.payload);
      this.flushTimer = setTimeout(tick, this.flushInterval);
    };

    tick();
  }

  /** Discard all buffered messages and cancel any in-progress flush. */
  clear(): void {
    this.queue = [];
    this.stopFlush();
  }

  /** Number of messages currently in the buffer. */
  get size(): number {
    return this.queue.length;
  }

  /** Whether buffering is enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  private stopFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private purgeExpired(): void {
    const now = Date.now();
    this.queue = this.queue.filter((msg) => {
      if (msg.ttl === null) return true;
      return now - msg.queuedAt < msg.ttl;
    });
  }

  /**
   * Resolve TTL for a message. Most specific wins:
   * 1. Per-call ttl
   * 2. Per-event bufferTTL[event]
   * 3. Global bufferTTL (number)
   * 4. null (no expiry)
   */
  private resolveTTL(event: string, perCallTtl?: number): number | null {
    if (perCallTtl !== undefined) return perCallTtl;
    if (typeof this.ttlConfig === 'number') return this.ttlConfig;
    if (typeof this.ttlConfig === 'object') return this.ttlConfig[event] ?? null;
    return null;
  }
}
