import type { WireMessage } from '~/internal/runtime.ts';

/** Settings for the buffer. */
export interface MessageBufferOptions {
  enabled?: boolean;
  maxSize?: number;
  ttl?: number | Record<string, number>;
  flushInterval?: number;
}

interface BufferedMessage {
  message: WireMessage;
  ttl: number | null;
  queuedAt: number;
}

/**
 * Holds messages you send while the socket is down and replays them in order
 * when it comes back. A message can carry a time-to-live so a stale one (like a
 * typing indicator) is dropped instead of sent late.
 *
 * It stores messages in a fixed-size ring, so when it's full the oldest one is
 * overwritten without shifting the whole array.
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

  constructor(options: MessageBufferOptions) {
    this.enabled = options.enabled ?? false;
    this.maxSize = options.maxSize ?? 50;
    this.ttlConfig = options.ttl;
    this.flushInterval = options.flushInterval ?? 0;
    this.ring = new Array(this.maxSize).fill(null);
  }

  /**
   * Add a message. Returns `true` if it was taken, `false` if buffering is off.
   * If the buffer is full the oldest message is dropped to make room.
   */
  enqueue(message: WireMessage, perCallTtl?: number): boolean {
    if (!this.enabled) return false;

    const ttl = this.resolveTTL(message.event, perCallTtl);
    const tail = (this.head + this.count) % this.maxSize;
    this.ring[tail] = { message, ttl, queuedAt: Date.now() };

    if (this.count >= this.maxSize) {
      this.head = (this.head + 1) % this.maxSize;
    } else {
      this.count++;
    }

    return true;
  }

  /**
   * Send everything in the buffer, dropping anything past its TTL first. With
   * `flushInterval` of `0` they all go at once; otherwise one goes every
   * `flushInterval` ms, which is gentler on a rate-limited server.
   */
  flush(send: (message: WireMessage) => void, onComplete?: () => void): void {
    const messages = this.drain();
    const now = Date.now();
    const valid: BufferedMessage[] = [];
    for (const buffered of messages) {
      if (buffered.ttl === null || now - buffered.queuedAt < buffered.ttl) {
        valid.push(buffered);
      }
    }

    if (valid.length === 0) {
      onComplete?.();
      return;
    }

    if (this.flushInterval <= 0) {
      for (const buffered of valid) {
        send(buffered.message);
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
      const buffered = valid[index++]!;
      send(buffered.message);
      this.flushTimer = setTimeout(tick, this.flushInterval);
    };

    tick();
  }

  /** Throw away everything and stop any in-progress flush. */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.ring[(this.head + i) % this.maxSize] = null;
    }
    this.head = 0;
    this.count = 0;
    this.stopFlush();
  }

  get size(): number {
    return this.count;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private stopFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Pull every message out in order and reset the ring. */
  private drain(): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.maxSize;
      result.push(this.ring[index]!);
      this.ring[index] = null;
    }
    this.head = 0;
    this.count = 0;
    return result;
  }

  /** Pick the TTL: a per-call value wins, then per-event, then a global number, else none. */
  private resolveTTL(event: string, perCallTtl?: number): number | null {
    if (perCallTtl !== undefined) return perCallTtl;
    if (typeof this.ttlConfig === 'number') return this.ttlConfig;
    if (typeof this.ttlConfig === 'object') return this.ttlConfig[event] ?? null;
    return null;
  }
}
