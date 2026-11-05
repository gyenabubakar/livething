import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCloseReason, normalizeConnectionDescriptor } from './close.ts';

describe('normalizeCloseReason', () => {
  it('leaves a reason within the WebSocket limit unchanged', () => {
    expect(normalizeCloseReason('connection closed')).toBe('connection closed');
  });

  it('truncates by UTF-8 bytes without splitting a character', () => {
    const reason = normalizeCloseReason('🙂'.repeat(100));

    expect(reason).toBe('🙂'.repeat(30));
    expect(new TextEncoder().encode(reason).byteLength).toBe(120);
  });

  it('preserves an omitted reason', () => {
    expect(normalizeCloseReason()).toBeUndefined();
  });

  it('keeps custom descriptor methods bound to their original instance', () => {
    class Descriptor {
      #sent = 0;
      readonly userId = 'user-1';
      readonly close = vi.fn();

      send(): void {
        this.#sent += 1;
      }

      bufferedAmount(): number {
        return this.#sent;
      }
    }

    const original = new Descriptor();
    const descriptor = normalizeConnectionDescriptor(original);

    descriptor.send({ kind: 'text', text: 'frame' });
    descriptor.close(1000, '🙂'.repeat(100));

    expect(descriptor.bufferedAmount()).toBe(1);
    expect(original.close).toHaveBeenCalledWith(1000, '🙂'.repeat(30));
  });

  it('logs through its owner and closes safely for an invalid code', () => {
    const close = vi.fn();
    const onInvalidCloseCode = vi.fn();
    const descriptor = normalizeConnectionDescriptor(
      { send() {}, close, bufferedAmount: () => 0 },
      { onInvalidCloseCode },
    );

    descriptor.close(4000.5, 'do not expose this');

    expect(onInvalidCloseCode).toHaveBeenCalledWith(4000.5);
    expect(close).toHaveBeenCalledWith(1011, 'Internal error');
  });
});

describe('the send limit of a normalized descriptor', () => {
  it('counts a bytes frame by its byteLength', () => {
    const send = vi.fn();
    const descriptor = normalizeConnectionDescriptor(
      { send, close() {}, bufferedAmount: () => 0 },
      { sendBytes: 100 },
    );

    descriptor.send({ kind: 'bytes', bytes: new Uint8Array(100) });

    expect(() => descriptor.send({ kind: 'bytes', bytes: new Uint8Array(101) })).toThrow(
      /101 bytes is over the send limit of 100 bytes/,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('counts a text frame in UTF-8 bytes', () => {
    const descriptor = normalizeConnectionDescriptor(
      { send() {}, close() {}, bufferedAmount: () => 0 },
      { sendBytes: 100 },
    );

    expect(() => descriptor.send({ kind: 'text', text: 'é'.repeat(51) })).toThrow(
      /102 bytes is over the send limit of 100 bytes/,
    );
  });
});

describe('the slow-member close of a normalized descriptor', () => {
  const frame = { kind: 'text', text: 'hi' } as const;

  let skew = 0;

  // The check reads the monotonic clock, so the tests move `performance.now()` on.
  beforeEach(() => {
    skew = 0;
    const realNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skew);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function later(ms: number): void {
    skew += ms;
  }

  it('is not fooled by the system clock jumping forward', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { descriptor, close } = watched(() => 201);

      descriptor.send(frame);
      vi.setSystemTime(Date.now() + 60_000);

      expect(descriptor.send(frame)).toBe(true);
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  function watched(buffered: () => number) {
    const send = vi.fn(() => true);
    const close = vi.fn();
    const descriptor = normalizeConnectionDescriptor(
      { send, close, bufferedAmount: buffered, backpressureSupported: true },
      { sendBytes: 100 },
    );

    return { descriptor, send, close };
  }

  it('does not close a socket whose buffer is far over the limit but drains within 10 seconds', () => {
    let buffered = 100_000;
    const { descriptor, close } = watched(() => buffered);

    descriptor.send(frame);
    later(9_999);
    descriptor.send(frame);
    buffered = 0;
    later(5_000);

    expect(descriptor.send(frame)).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes on the next send once the buffer stayed over the limit for more than 10 seconds', () => {
    const { descriptor, send, close } = watched(() => 201);

    descriptor.send(frame);
    later(10_001);

    expect(descriptor.send(frame)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1013, expect.stringMatching(/^\[livething\] /));
  });

  it('starts the 10 seconds again after the buffer drops to the limit', () => {
    let buffered = 201;
    const { descriptor, close } = watched(() => buffered);

    descriptor.send(frame);
    later(6_000);
    buffered = 200;
    descriptor.send(frame);
    buffered = 201;

    descriptor.send(frame);
    later(6_000);
    descriptor.send(frame);

    expect(close).not.toHaveBeenCalled();
  });

  it('does not close a socket the engine already closed', () => {
    const { descriptor, send, close } = watched(() => 500);
    descriptor.send(frame);
    descriptor.close(1000, 'bye');
    later(10_001);

    expect(descriptor.send({ kind: 'text', text: 'late' })).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
