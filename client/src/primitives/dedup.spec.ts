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

    ws.emit({ event: 'trade', payload: { id: 'A' }, metadata: { delivery: { id: 'A' } } });
    expect(handler).toHaveBeenCalledTimes(1);

    for (const id of ['B', 'C', 'D', 'E']) {
      ws.emit({ event: 'trade', payload: { id }, metadata: { delivery: { id: id } } });
    }

    expect(handler).toHaveBeenCalledTimes(5);

    ws.emit({ event: 'trade', payload: { id: 'A' }, metadata: { delivery: { id: 'A' } } });
    expect(handler).toHaveBeenCalledTimes(5);
  });
});

describe('dedup — window eviction', () => {
  it('re-delivers a message after its id has aged past windowMs', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(500);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: 'x' }, metadata: { delivery: { id: 'id-1' } } });
    expect(handler).toHaveBeenCalledTimes(1);

    ws.emit({ event: 'trade', payload: { id: 'x' }, metadata: { delivery: { id: 'id-1' } } });
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(501);

    ws.emit({ event: 'trade', payload: { id: 'x' }, metadata: { delivery: { id: 'id-1' } } });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('early-break: a still-fresh entry stops eviction so newer ids are not dropped', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(1000);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: '1' }, metadata: { delivery: { id: 'id-old' } } });
    vi.advanceTimersByTime(600);
    ws.emit({ event: 'trade', payload: { id: '2' }, metadata: { delivery: { id: 'id-new' } } });
    expect(handler).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(500);

    ws.emit({ event: 'trade', payload: { id: '1' }, metadata: { delivery: { id: 'id-old' } } });
    expect(handler).toHaveBeenCalledTimes(3);

    ws.emit({ event: 'trade', payload: { id: '2' }, metadata: { delivery: { id: 'id-new' } } });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('evicts multiple stale ids in a single pass before the fresh ones', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(300);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: '1' }, metadata: { delivery: { id: 'stale-1' } } });
    ws.emit({ event: 'trade', payload: { id: '2' }, metadata: { delivery: { id: 'stale-2' } } });
    ws.emit({ event: 'trade', payload: { id: '3' }, metadata: { delivery: { id: 'stale-3' } } });
    expect(handler).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(301);

    ws.emit({ event: 'trade', payload: { id: '4' }, metadata: { delivery: { id: 'fresh-1' } } });
    expect(handler).toHaveBeenCalledTimes(4);

    ws.emit({ event: 'trade', payload: { id: '1' }, metadata: { delivery: { id: 'stale-1' } } });
    ws.emit({ event: 'trade', payload: { id: '2' }, metadata: { delivery: { id: 'stale-2' } } });
    ws.emit({ event: 'trade', payload: { id: '3' }, metadata: { delivery: { id: 'stale-3' } } });
    expect(handler).toHaveBeenCalledTimes(7);
  });
});

describe('dedup — sliding window', () => {
  it('keeps an id remembered as long as repeats keep arriving', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(1000);
    const handler = vi.fn();
    socket.on('trade', handler);

    ws.emit({ event: 'trade', payload: { id: 'A' }, metadata: { delivery: { id: 'A' } } });
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600);
    ws.emit({ event: 'trade', payload: { id: 'A' }, metadata: { delivery: { id: 'A' } } });
    expect(handler).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600);
    ws.emit({ event: 'trade', payload: { id: 'A' }, metadata: { delivery: { id: 'A' } } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
