import { encodeMessage, LiveThingConfigError, utf8ByteLength } from '@livething/core';
import { Disconnected, Dropped } from '~/errors.ts';
import { assertValidTtl, MAX_TIMER_DELAY_MS } from '~/internal/config.ts';
import type { FrameOwner, Message } from '~/internal/runtime.ts';

/** Settings for the buffer. */
export interface MessageBufferOptions {
  maxMessages?: number;
  maxBytes?: number;
  ttl?: number;
  flushInterval?: number;
}

interface BufferedMessage {
  message: Message;
  /** The message's size on the wire, in UTF-8 bytes. */
  bytes: number;
  ttl: number | null;
  queuedAt: number;
  owner?: FrameOwner;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new LiveThingConfigError(`buffering ${name} must be a positive integer, got ${value}.`);
  }
}

/**
 * Holds messages you send while the socket is down and replays them in order
 * when it comes back. A message can carry a time-to-live so a stale one (like a
 * typing indicator) is dropped instead of sent late.
 *
 * It stores messages in a fixed-size ring, so when it's full the oldest one is
 * dropped without shifting the whole array.
 */
export class MessageBuffer {
  private ring: (BufferedMessage | null)[];
  private head = 0;
  private count = 0;
  private bytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly defaultTtl: number | null;
  private readonly flushInterval: number;

  constructor(options: MessageBufferOptions) {
    this.maxMessages = options.maxMessages ?? 50;
    assertPositiveInteger(this.maxMessages, 'maxMessages');
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    assertPositiveInteger(this.maxBytes, 'maxBytes');

    const { ttl } = options;
    if (ttl !== undefined) assertValidTtl(ttl, 'buffering');

    this.defaultTtl = ttl ?? null;

    this.flushInterval = options.flushInterval ?? 0;
    if (
      !Number.isFinite(this.flushInterval) ||
      this.flushInterval < 0 ||
      this.flushInterval > MAX_TIMER_DELAY_MS
    ) {
      throw new LiveThingConfigError(
        `buffering flushInterval must be a number of ms from 0 to ${MAX_TIMER_DELAY_MS}, got ${this.flushInterval}.`,
      );
    }

    this.ring = new Array(this.maxMessages).fill(null);
  }

  /**
   * Add a message, and return whether it was taken.
   * When the buffer would go over `maxMessages` or `maxBytes`, the oldest messages are
   * dropped to make room. A message bigger than `maxBytes` alone is never queued: it is
   * refused, and the send returns `'dropped'`, so its caller rejects with `Dropped` instead
   * of waiting for a flush that will never send it.
   */
  enqueue(message: Message, perCallTtl?: number, owner?: FrameOwner): boolean {
    const ttl = perCallTtl ?? this.defaultTtl;
    const bytes = utf8ByteLength(encodeMessage(message));
    if (bytes > this.maxBytes) return false;

    // Reject each dropped owner, so a Promise-bearing op whose frame was dropped fails
    // instead of hanging.
    while (
      this.count > 0 &&
      (this.count >= this.maxMessages || this.bytes + bytes > this.maxBytes)
    ) {
      this.dequeue()?.owner?.reject(Dropped());
    }

    this.push({ message, bytes, ttl, queuedAt: Date.now(), owner });

    return true;
  }

  private push(buffered: BufferedMessage): void {
    this.ring[(this.head + this.count) % this.maxMessages] = buffered;
    this.count++;
    this.bytes += buffered.bytes;
  }

  /**
   * Send everything in the buffer, dropping anything past its TTL first. With
   * `flushInterval` of `0` they all go at once; otherwise one goes every
   * `flushInterval` ms, which is gentler on a rate-limited server.
   *
   * A message leaves the buffer only when it's actually handed to `send`, never
   * up front. So if the socket drops mid-flush, `stopFlush()` leaves the
   * not-yet-sent messages in the buffer and they go out on the next flush.
   */
  flush(send: (message: Message) => void, onError?: (error: unknown) => void): void {
    this.stopFlush();
    this.dropExpired();

    // Isolate each send. A frame whose owner already settled (timed out, was
    // disconnected, or resolved by another path) is dropped, not sent — its op no
    // longer wants it on the wire. A send that throws (serialization failure)
    // rejects the owner so the op fails instead of hanging, and is also reported.
    function sendOne(buffered: BufferedMessage): void {
      if (buffered.owner && !buffered.owner.isPending()) return;

      try {
        send(buffered.message);
      } catch (error) {
        buffered.owner?.reject(error);
        onError?.(error);
      }
    }

    if (this.flushInterval <= 0) {
      let buffered = this.dequeue();
      while (buffered) {
        sendOne(buffered);
        buffered = this.dequeue();
      }

      return;
    }

    const tick = (): void => {
      const buffered = this.dequeue();
      if (!buffered) {
        this.flushTimer = null;
        return;
      }

      sendOne(buffered);
      this.flushTimer = this.count > 0 ? setTimeout(tick, this.flushInterval) : null;
    };

    tick();
  }

  /**
   * Throw away everything and stop any in-progress flush. A pending owner whose
   * frame is discarded is rejected, so an intentional clear (e.g. `disconnect()`)
   * fails its buffered ops instead of leaving them to hang.
   */
  clear(): void {
    for (const buffered of this.drain()) {
      if (buffered.owner?.isPending()) buffered.owner.reject(Disconnected());
    }

    this.stopFlush();
  }

  /** True while a staggered flush is still draining (its next tick is scheduled). */
  get isFlushing(): boolean {
    return this.flushTimer !== null;
  }

  /** Stop an in-progress staggered flush, leaving any unsent messages in place. */
  stopFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Remove and return the oldest message, or `null` when the buffer is empty. */
  private dequeue(): BufferedMessage | null {
    if (this.count === 0) return null;

    const buffered = this.ring[this.head]!;
    this.ring[this.head] = null;
    this.head = (this.head + 1) % this.maxMessages;
    this.count--;
    this.bytes -= buffered.bytes;

    return buffered;
  }

  /** Drop messages past their TTL, keeping the rest in order. An expired frame's
   * pending owner is rejected so its op fails instead of waiting out its timeout. */
  private dropExpired(): void {
    const now = Date.now();
    const kept = this.drain().filter((buffered) => {
      const alive =
        buffered.ttl === null || buffered.ttl <= 0 || now - buffered.queuedAt < buffered.ttl;
      if (!alive && buffered.owner?.isPending()) buffered.owner.reject(Dropped());
      return alive;
    });
    for (const buffered of kept) this.push(buffered);
  }

  /** Pull every message out in order and reset the ring. */
  private drain(): BufferedMessage[] {
    const result: BufferedMessage[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.maxMessages;
      result.push(this.ring[index]!);
      this.ring[index] = null;
    }

    this.head = 0;
    this.count = 0;
    this.bytes = 0;

    return result;
  }
}
