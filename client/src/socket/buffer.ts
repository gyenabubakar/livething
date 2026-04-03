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
 * Uses a ring buffer internally so overflow eviction is O(1) instead of
 * O(n) array shifting.
 *
 * Internal module — not exported from the package. Used by Socket.
 */
export class MessageBuffer {
  private ring: (BufferedMessage | null)[];
  private head = 0;
  private count = 0;
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
    this.ring = new Array(this.maxSize).fill(null);
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
    const tail = (this.head + this.count) % this.maxSize;
    this.ring[tail] = { event, payload, ttl, queuedAt: Date.now() };

    if (this.count >= this.maxSize) {
      this.head = (this.head + 1) % this.maxSize;
    } else {
      this.count++;
    }

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
    const messages = this.drain();
    const now = Date.now();
    const valid: BufferedMessage[] = [];
    for (const msg of messages) {
      if (msg.ttl === null || now - msg.queuedAt < msg.ttl) {
        valid.push(msg);
      }
    }

    if (valid.length === 0) {
      onComplete?.();
      return;
    }

    if (this.flushInterval <= 0) {
      for (const msg of valid) {
        send(msg.event, msg.payload);
      }
      onComplete?.();
      return;
    }

    let index = 0;
    const tick = (): void => {
      if (index >= valid.length) {
        this.flushTimer = null;
        onComplete?.();
        return;
      }
      const msg = valid[index++]!;
      send(msg.event, msg.payload);
      this.flushTimer = setTimeout(tick, this.flushInterval);
    };

    tick();
  }

  /** Discard all buffered messages and cancel any in-progress flush. */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.ring[(this.head + i) % this.maxSize] = null;
    }
    this.head = 0;
    this.count = 0;
    this.stopFlush();
  }

  /** Number of messages currently in the buffer. */
  get size(): number {
    return this.count;
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

  /** Extract all messages from the ring in order, resetting the buffer. */
  private drain(): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.maxSize;
      result.push(this.ring[idx]!);
      this.ring[idx] = null;
    }
    this.head = 0;
    this.count = 0;
    return result;
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
