import { MessageBuffer } from '@/socket/buffer.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BufferOptions } from '@/socket/buffer.ts';

function createBuffer(overrides: Partial<BufferOptions> = {}) {
  const opts: BufferOptions = {
    bufferWhileDisconnected: true,
    ...overrides,
  };
  return new MessageBuffer(opts);
}

describe('MessageBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Enqueue ───────────────────────────────────────────────

  it('enqueues messages when enabled', () => {
    const buffer = createBuffer();
    expect(buffer.enqueue('typing', { id: '1' })).toBe(true);
    expect(buffer.size).toBe(1);
  });

  it('returns false when buffering is disabled', () => {
    const buffer = createBuffer({ bufferWhileDisconnected: false });
    expect(buffer.enqueue('typing', { id: '1' })).toBe(false);
    expect(buffer.size).toBe(0);
  });

  it('drops oldest messages when maxBufferSize is exceeded', () => {
    const buffer = createBuffer({ maxBufferSize: 2 });
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.enqueue('c', 3);

    expect(buffer.size).toBe(2);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('handles maxBufferSize of 1', () => {
    const buffer = createBuffer({ maxBufferSize: 1 });
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.enqueue('c', 3);

    expect(buffer.size).toBe(1);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));
    expect(sent).toEqual([['c', 3]]);
  });

  // ── Flush ─────────────────────────────────────────────────

  it('flushes all messages in order (flushInterval = 0)', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.enqueue('c', 3);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(buffer.size).toBe(0);
  });

  it('calls onComplete after immediate flush', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);

    const onComplete = vi.fn();
    buffer.flush(vi.fn(), onComplete);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls onComplete when buffer is empty', () => {
    const buffer = createBuffer();
    const onComplete = vi.fn();
    buffer.flush(vi.fn(), onComplete);

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('flushes with interval when flushInterval > 0', () => {
    const buffer = createBuffer({ flushInterval: 50 });
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.enqueue('c', 3);

    const sent: [string, unknown][] = [];
    const onComplete = vi.fn();
    buffer.flush((e, p) => sent.push([e, p]), onComplete);

    // First message sent immediately (tick() called synchronously)
    expect(sent).toEqual([['a', 1]]);

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([
      ['a', 1],
      ['b', 2],
    ]);

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);

    vi.advanceTimersByTime(50);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('throttled flush with a single message completes immediately', () => {
    const buffer = createBuffer({ flushInterval: 50 });
    buffer.enqueue('a', 1);

    const sent: [string, unknown][] = [];
    const onComplete = vi.fn();
    buffer.flush((e, p) => sent.push([e, p]), onComplete);

    // Single message sent on first tick
    expect(sent).toEqual([['a', 1]]);
    // onComplete fires after the next scheduled tick confirms empty queue
    vi.advanceTimersByTime(50);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('flush when all messages are expired sends nothing', () => {
    const buffer = createBuffer({ bufferTTL: 1000 });
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);

    vi.advanceTimersByTime(2000);

    const sent: [string, unknown][] = [];
    const onComplete = vi.fn();
    buffer.flush((e, p) => sent.push([e, p]), onComplete);

    expect(sent).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('buffer can be reused after flush', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);

    buffer.flush(vi.fn());
    expect(buffer.size).toBe(0);

    buffer.enqueue('b', 2);
    expect(buffer.size).toBe(1);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));
    expect(sent).toEqual([['b', 2]]);
  });

  it('buffer can be reused after clear', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);
    buffer.clear();

    buffer.enqueue('b', 2);
    expect(buffer.size).toBe(1);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));
    expect(sent).toEqual([['b', 2]]);
  });

  // ── Clear ─────────────────────────────────────────────────

  it('clears all messages', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.clear();

    expect(buffer.size).toBe(0);
  });

  it('cancels in-progress throttled flush on clear', () => {
    const buffer = createBuffer({ flushInterval: 50 });
    buffer.enqueue('a', 1);
    buffer.enqueue('b', 2);
    buffer.enqueue('c', 3);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    // First sent immediately
    expect(sent.length).toBe(1);

    buffer.clear();
    vi.advanceTimersByTime(200);

    // No more messages sent after clear
    expect(sent.length).toBe(1);
  });

  // ── TTL ───────────────────────────────────────────────────

  it('drops expired messages on flush (global TTL)', () => {
    const buffer = createBuffer({ bufferTTL: 5000 });
    buffer.enqueue('a', 1);

    vi.advanceTimersByTime(6000);
    buffer.enqueue('b', 2);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['b', 2]]);
  });

  it('uses per-event TTL from bufferTTL record', () => {
    const buffer = createBuffer({
      bufferTTL: { typing: 2000, message: 10000 },
    });

    buffer.enqueue('typing', 1);
    buffer.enqueue('message', 2);

    vi.advanceTimersByTime(3000);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['message', 2]]);
  });

  it('per-call TTL overrides global number TTL', () => {
    const buffer = createBuffer({ bufferTTL: 10000 });

    buffer.enqueue('a', 1, 1000); // per-call: 1s
    buffer.enqueue('b', 2); // global: 10s

    vi.advanceTimersByTime(2000);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['b', 2]]);
  });

  it('per-call TTL overrides per-event record TTL', () => {
    const buffer = createBuffer({
      bufferTTL: { typing: 10000 },
    });

    buffer.enqueue('typing', 1, 1000); // per-call: 1s overrides per-event: 10s
    buffer.enqueue('typing', 2); // per-event: 10s

    vi.advanceTimersByTime(2000);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['typing', 2]]);
  });

  it('messages without TTL never expire', () => {
    const buffer = createBuffer();
    buffer.enqueue('a', 1);

    vi.advanceTimersByTime(60_000);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['a', 1]]);
  });

  it('events not in the bufferTTL record have no expiry', () => {
    const buffer = createBuffer({
      bufferTTL: { typing: 2000 },
    });

    buffer.enqueue('typing', 1);
    buffer.enqueue('message', 2);

    vi.advanceTimersByTime(3000);

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    expect(sent).toEqual([['message', 2]]);
  });

  it('message at exactly the TTL boundary is dropped', () => {
    const buffer = createBuffer({ bufferTTL: 1000 });
    buffer.enqueue('a', 1);

    vi.advanceTimersByTime(1000); // exactly at TTL

    const sent: [string, unknown][] = [];
    buffer.flush((e, p) => sent.push([e, p]));

    // TTL check is `now - queuedAt < ttl` — equal means expired
    expect(sent).toEqual([]);
  });

  // ── Properties ────────────────────────────────────────────

  it('isEnabled reflects the bufferWhileDisconnected option', () => {
    expect(createBuffer({ bufferWhileDisconnected: true }).isEnabled).toBe(true);
    expect(createBuffer({ bufferWhileDisconnected: false }).isEnabled).toBe(false);
  });

  it('defaults to disabled', () => {
    const buffer = new MessageBuffer({});
    expect(buffer.isEnabled).toBe(false);
  });
});
