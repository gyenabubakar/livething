import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { buildActiveStream, buildDrain, DEFAULT_HIGH_WATER_MARK } from './active-stream.ts';
import type { DrainTarget } from './active-stream.ts';

/**
 * Phase 6 — outbound backpressure (`ctx.stream.drain()`).
 *
 * Drain resolves immediately when the buffer is under the mark, polls until it
 * drops when over, no-ops when the platform reports no backpressure support
 * (Cloudflare), and on a broadcast stream paces against the *healthiest* client
 * (the least-buffered) rather than the slowest.
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

  it('resolves immediately when buffered is under the high water mark', async () => {
    const target = fakeTarget({ buffered: 0 });
    const drain = buildDrain({
      targets: () => [target],
      highWaterMark: 1000,
      isClosed: () => false,
    });
    await expect(drain()).resolves.toBeUndefined();
  });

  it('polls until the buffer drops below the mark, then resolves', async () => {
    const state = { buffered: 5000 };
    let polls = 0;
    const drain = buildDrain({
      targets: () => [fakeTarget(state)],
      highWaterMark: 1000,
      isClosed: () => false,
      delay: async () => {
        polls += 1;
        if (polls >= 3) state.buffered = 100;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polls).toBe(3);
  });

  it('is a no-op when the platform does not support backpressure (Cloudflare)', async () => {
    const target = fakeTarget({ buffered: 999_999, supported: false });
    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      highWaterMark: 1000,
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
      descriptor: { bufferedAmount: () => 999_999 },
    };

    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      highWaterMark: 1000,
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
    // because the *best* target is under the mark — the slow client never stalls
    // the generator.
    const slow = fakeTarget({ buffered: 1_000_000 });
    const healthy = fakeTarget({ buffered: 10 });
    let polled = false;
    const drain = buildDrain({
      targets: () => [slow, healthy],
      highWaterMark: 1000,
      isClosed: () => false,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();

    expect(polled).toBe(false);
  });

  it('keeps polling while every client is over the mark', async () => {
    const a = { buffered: 5000 };
    const b = { buffered: 4000 };
    let polls = 0;
    const drain = buildDrain({
      targets: () => [fakeTarget(a), fakeTarget(b)],
      highWaterMark: 1000,
      isClosed: () => false,
      delay: async () => {
        polls += 1;
        if (polls >= 2) b.buffered = 100;
      },
    });
    await drain();

    expect(polls).toBe(2);
  });

  it('resolves at once when the stream is already closed (no hang on teardown)', async () => {
    const target = fakeTarget({ buffered: 999_999 });
    let polled = false;
    const drain = buildDrain({
      targets: () => [target],
      highWaterMark: 1000,
      isClosed: () => true,
      delay: async () => {
        polled = true;
      },
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(polled).toBe(false);
  });
});

describe('buildActiveStream highWaterMark', () => {
  function fakeConnection(): RuntimeConnection {
    return { id: 'c1', descriptor: { bufferedAmount: () => 0 } } as unknown as RuntimeConnection;
  }

  async function* emptyGen(): AsyncGenerator<unknown, void, unknown> {}

  it('defaults highWaterMark to 256 KB when the config omits it', () => {
    const { active } = buildActiveStream({
      streamId: 's1',
      event: 'feed',
      connection: fakeConnection(),
      generator: emptyGen(),
      nudges: [],
    });
    expect(active.highWaterMark).toBe(DEFAULT_HIGH_WATER_MARK);
    expect(DEFAULT_HIGH_WATER_MARK).toBe(256 * 1024);
  });

  it('uses the override when the config provides one', () => {
    const { active } = buildActiveStream({
      streamId: 's2',
      event: 'feed',
      connection: fakeConnection(),
      generator: emptyGen(),
      nudges: [],
      highWaterMark: 64 * 1024,
    });
    expect(active.highWaterMark).toBe(64 * 1024);
  });
});
