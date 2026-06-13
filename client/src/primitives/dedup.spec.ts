import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { trade: { id: string } };
  outgoing: never;
}

function build(windowMs?: number) {
  const socket = client<C>()(
    connect('wss://test'),
    windowMs !== undefined ? dedup({ windowMs }) : dedup(),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function buildWithWindow(windowMs: number) {
  const socket = client<C>()(connect('wss://test'), dedup({ windowMs }));
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

describe('dedup — keeps every id within the window', () => {
  it('a still-fresh id stays blocked even after many later ids arrive', () => {
    vi.useFakeTimers();
    const { socket, ws } = buildWithWindow(60_000);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: 'A' }, __wskit: { messageId: 'A' } });
    expect(handler).toHaveBeenCalledTimes(1);

    for (const id of ['B', 'C', 'D', 'E']) {
      ws.emit({ event: 'trade', payload: { id }, __wskit: { messageId: id } });
    }
    expect(handler).toHaveBeenCalledTimes(5);

    // A is still within the window — replaying it MUST be blocked as a duplicate.
    ws.emit({ event: 'trade', payload: { id: 'A' }, __wskit: { messageId: 'A' } });
    expect(handler).toHaveBeenCalledTimes(5);
  });
});

describe('dedup — window eviction', () => {
  it('re-delivers a message after its id has aged past windowMs', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(500);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: 'x' }, __wskit: { messageId: 'id-1' } });
    expect(handler).toHaveBeenCalledTimes(1);

    // Second arrival within the window — must be dropped.
    ws.emit({ event: 'trade', payload: { id: 'x' }, __wskit: { messageId: 'id-1' } });
    expect(handler).toHaveBeenCalledTimes(1);

    // Advance past the window so the id is evicted.
    vi.advanceTimersByTime(501);

    // Same id now — must be delivered again because it was forgotten.
    ws.emit({ event: 'trade', payload: { id: 'x' }, __wskit: { messageId: 'id-1' } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('early-break: a still-fresh entry stops eviction so newer ids are not dropped', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(1000);
    const handler = vi.fn();
    socket.on('trade', handler);

    // Emit id-old, then advance almost to the boundary, then emit id-new.
    ws.emit({ event: 'trade', payload: { id: '1' }, __wskit: { messageId: 'id-old' } });
    vi.advanceTimersByTime(600);
    ws.emit({ event: 'trade', payload: { id: '2' }, __wskit: { messageId: 'id-new' } });
    expect(handler).toHaveBeenCalledTimes(2);

    // Advance 500 ms more (total 1100 ms): id-old is now outside the window but
    // id-new is still inside (only 500 ms old). The early-break means eviction
    // stops at id-old and removes it, but does NOT touch id-new.
    vi.advanceTimersByTime(500);

    // id-old is evicted — re-delivery must go through.
    ws.emit({ event: 'trade', payload: { id: '1' }, __wskit: { messageId: 'id-old' } });
    expect(handler).toHaveBeenCalledTimes(3);

    // id-new is still inside the window — must be treated as a duplicate.
    ws.emit({ event: 'trade', payload: { id: '2' }, __wskit: { messageId: 'id-new' } });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('evicts multiple stale ids in a single pass before the fresh ones', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(300);
    const handler = vi.fn();
    socket.on('trade', handler);

    // Seed three ids that will become stale.
    ws.emit({ event: 'trade', payload: { id: '1' }, __wskit: { messageId: 'stale-1' } });
    ws.emit({ event: 'trade', payload: { id: '2' }, __wskit: { messageId: 'stale-2' } });
    ws.emit({ event: 'trade', payload: { id: '3' }, __wskit: { messageId: 'stale-3' } });
    expect(handler).toHaveBeenCalledTimes(3);

    // Advance past the window — all three become stale.
    vi.advanceTimersByTime(301);

    // Emit a brand-new id to trigger the eviction pass.
    ws.emit({ event: 'trade', payload: { id: '4' }, __wskit: { messageId: 'fresh-1' } });
    expect(handler).toHaveBeenCalledTimes(4);

    // All three stale ids must have been evicted — re-delivering them must go through.
    ws.emit({ event: 'trade', payload: { id: '1' }, __wskit: { messageId: 'stale-1' } });
    ws.emit({ event: 'trade', payload: { id: '2' }, __wskit: { messageId: 'stale-2' } });
    ws.emit({ event: 'trade', payload: { id: '3' }, __wskit: { messageId: 'stale-3' } });
    expect(handler).toHaveBeenCalledTimes(7);
  });
});

describe('dedup — sliding window', () => {
  it('keeps an id remembered as long as repeats keep arriving', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(1000);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: 'A' }, __wskit: { messageId: 'A' } });
    expect(handler).toHaveBeenCalledTimes(1); // delivered, last-seen = t0

    vi.advanceTimersByTime(600);
    ws.emit({ event: 'trade', payload: { id: 'A' }, __wskit: { messageId: 'A' } });
    expect(handler).toHaveBeenCalledTimes(1); // dropped; refreshes last-seen to t600

    vi.advanceTimersByTime(600); // t1200 — but only 600ms since the last sighting
    ws.emit({ event: 'trade', payload: { id: 'A' }, __wskit: { messageId: 'A' } });
    // Sliding window: still within 1000ms of the last sighting → still dropped.
    // (A fixed-from-first-sight window would have evicted it at t1000 and let this through.)
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
