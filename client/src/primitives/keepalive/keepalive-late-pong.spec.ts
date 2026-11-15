import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketContract } from '~/types.ts';

const INTERVAL = 30_000;

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

function build() {
  const socket = client<SocketContract>()(connect('wss://test'), keepalive());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open('', { pingIntervalMs: INTERVAL });

  return { socket, ws };
}

/** Plays a network whose every pong arrives `roundTrip` ms after its ping, and returns the latency seen after each pong. */
function playNetwork({ socket, ws }: ReturnType<typeof build>, roundTrip: number, pings: number) {
  const events: Array<{ at: number; type: 'ping' | 'pong' }> = [];
  for (let n = 1; n <= pings; n++) {
    events.push({ at: n * INTERVAL, type: 'ping' });
    events.push({ at: n * INTERVAL + roundTrip, type: 'pong' });
  }

  events.sort((a, b) => a.at - b.at || (a.type === 'pong' ? -1 : 1));

  const seen: Array<number | null> = [];
  let now = 0;
  for (const { at, type } of events) {
    vi.advanceTimersByTime(at - now);
    now = at;
    if (type === 'pong') {
      ws.emit('pong');
      seen.push(socket.latency.get());
    }
  }

  return seen;
}

describe('keepalive — a pong slower than the ping interval', () => {
  it('reports a 30,100ms round trip as 30100, with poor quality', () => {
    const { socket, ws } = build();

    vi.advanceTimersByTime(INTERVAL);
    vi.advanceTimersByTime(INTERVAL);
    vi.advanceTimersByTime(100);
    ws.emit('pong');

    expect(socket.latency.get()).toBe(30_100);
    expect(socket.quality.get()).toBe('poor');
  });

  it('reports a 50,000ms round trip as 50000, with poor quality', () => {
    const { socket, ws } = build();

    vi.advanceTimersByTime(INTERVAL);
    vi.advanceTimersByTime(INTERVAL);
    vi.advanceTimersByTime(20_000);
    ws.emit('pong');

    expect(socket.latency.get()).toBe(50_000);
    expect(socket.quality.get()).toBe('poor');
  });

  it('still reports 100 on a 100ms network', () => {
    const built = build();

    const seen = playNetwork(built, 100, 3);

    expect(seen).toEqual([100, 100, 100]);
    expect(built.socket.quality.get()).toBe('good');
  });
});

describe('keepalive — one ping in flight', () => {
  function pingsSent(ws: MockWebSocket) {
    return ws.sent.filter((frame) => frame === 'ping').length;
  }

  /** Answers every ping `roundTrip` ms after it was really sent, except the first `lost` pings. */
  function runNetwork(
    ws: MockWebSocket,
    { roundTrip, lost, duration }: { roundTrip: number; lost: number; duration: number },
  ) {
    let seen = 0;
    for (let elapsed = 0; elapsed < duration; elapsed += 100) {
      vi.advanceTimersByTime(100);
      const sent = pingsSent(ws);
      if (sent > seen) {
        if (seen >= lost) setTimeout(() => ws.emit('pong'), roundTrip);
        seen = sent;
      }
    }
  }

  it('sends no new ping while one is unanswered', () => {
    const { ws } = build();

    vi.advanceTimersByTime(INTERVAL * 2);

    expect(pingsSent(ws)).toBe(1);
  });

  it('reads 50000 every time when only pings really sent get a pong', () => {
    const { socket, ws } = build();
    const latencies: number[] = [];
    socket.latency.subscribe((latency) => {
      if (latency !== null) latencies.push(latency);
    });

    runNetwork(ws, { roundTrip: 50_000, lost: 0, duration: INTERVAL * 8 });

    expect(latencies.length).toBeGreaterThan(1);
    expect(new Set(latencies)).toEqual(new Set([50_000]));
    expect(socket.quality.get()).toBe('poor');
  });

  it('closes a 70,000ms network at maxMissedPongs 2', () => {
    const { ws } = build();

    runNetwork(ws, { roundTrip: 70_000, lost: 0, duration: INTERVAL * 3 });

    expect(ws.readyState).toBe(3);
    expect(pingsSent(ws)).toBe(1);
  });

  it('closes after a lost ping, and never reads an interval too high', () => {
    const socket = client<SocketContract>()(
      connect('wss://test'),
      keepalive({ maxMissedPongs: 3 }),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open('', { pingIntervalMs: INTERVAL });
    const latencies: number[] = [];

    socket.latency.subscribe((latency) => {
      if (latency !== null) latencies.push(latency);
    });

    runNetwork(ws, { roundTrip: 100, lost: 1, duration: INTERVAL * 3 });
    expect(ws.readyState).not.toBe(3);

    runNetwork(ws, { roundTrip: 100, lost: 1, duration: INTERVAL });

    expect(latencies.filter((latency) => latency > 100)).toEqual([]);
    expect(ws.readyState).toBe(3);
  });
});
