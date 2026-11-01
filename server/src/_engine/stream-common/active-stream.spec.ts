import { describe, expect, it } from 'vitest';
import { buildDrain, DRAIN_BUFFER_LIMIT_BYTES } from './active-stream.ts';
import type { DrainTarget } from './active-stream.ts';

const OVER = DRAIN_BUFFER_LIMIT_BYTES * 4;
const UNDER = 100;

/**
 * Phase 6 — outbound backpressure (`ctx.stream.drain()`).
 *
 * Drain resolves immediately when the buffer is under the 256 KB limit, polls
 * until it drops when over, no-ops when the platform reports no backpressure
 * support (Cloudflare), and on a broadcast stream paces against the *healthiest*
 * client (the least-buffered) rather than the slowest.
 */
describe('buildDrain', () => {
  /** A fake target whose buffered amount is read from a mutable holder. */
  function fakeTarget(state: { buffered: number; supported?: boolean }): DrainTarget {
    return {
      descriptor: {
        bufferedAmount: () => state.buffered,
        backpressureSupported: state.supported ?? true,
      },
    };
  }

  it('uses a fixed 256 KB limit', () => {
    expect(DRAIN_BUFFER_LIMIT_BYTES).toBe(256 * 1024);
  });

  it('resolves immediately when buffered is under the limit', async () => {
    const target = fakeTarget({ buffered: 0 });
    const drain = buildDrain({
      targets: () => [target],
      isClosed: () => false,
    });
    await expect(drain()).resolves.toBeUndefined();
  });

  it('keeps polling at exactly the limit', async () => {
    const state = { buffered: DRAIN_BUFFER_LIMIT_BYTES };
    let polls = 0;
    const drain = buildDrain({
      targets: () => [fakeTarget(state)],
      isClosed: () => false,
      delay: async () => {
        polls += 1;
        state.buffered = DRAIN_BUFFER_LIMIT_BYTES - 1;
      },
    });
    await drain();
    expect(polls).toBe(1);
  });

  it('polls until the buffer drops below the limit, then resolves', async () => {
    const state = { buffered: OVER };
    let polls = 0;
    const drain = buildDrain({
      targets: () => [fakeTarget(state)],
      isClosed: () => false,
      delay: async () => {
        polls += 1;
        if (polls >= 3) state.buffered = UNDER;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polls).toBe(3);
  });

  it('is a no-op when the platform does not support backpressure (Cloudflare)', async () => {
    const target = fakeTarget({ buffered: OVER, supported: false });
    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      isClosed: () => false,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polled).toBe(false);
  });

  it('no-ops when backpressureSupported is absent', async () => {
    const target: DrainTarget = {
      descriptor: { bufferedAmount: () => OVER },
    };

    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      isClosed: () => false,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polled).toBe(false);
  });

  it('paces a broadcast against the healthiest client, not the slowest', async () => {
    // One client is badly backed up; another is healthy. Drain must resolve
    // because the *best* target is under the limit — the slow client never
    // stalls the generator.
    const slow = fakeTarget({ buffered: OVER });
    const healthy = fakeTarget({ buffered: UNDER });
    let polled = false;
    const drain = buildDrain({
      targets: () => [slow, healthy],
      isClosed: () => false,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();

    expect(polled).toBe(false);
  });

  it('keeps polling while every client is over the limit', async () => {
    const a = { buffered: OVER };
    const b = { buffered: OVER - 1 };
    let polls = 0;
    const drain = buildDrain({
      targets: () => [fakeTarget(a), fakeTarget(b)],
      isClosed: () => false,
      delay: async () => {
        polls += 1;
        if (polls >= 2) b.buffered = UNDER;
      },
    });
    await drain();

    expect(polls).toBe(2);
  });

  it('resolves at once when the stream is already closed (no hang on teardown)', async () => {
    const target = fakeTarget({ buffered: OVER });
    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      isClosed: () => true,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polled).toBe(false);
  });
});
