import { CloseCodes } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { quality } from '~/primitives/quality.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyPrimitives, Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { WSKitSocket } from '~/socket/socket.ts';
import type { SocketContract } from '~/types.ts';

type C = SocketContract;

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...primitives) as unknown as Socket<C> &
    ApplyPrimitives<P, C>;
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

describe('keepalive — missed pong force close', () => {
  it('counts each unanswered ping as a missed pong and sets quality to poor on first miss', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 3 }));

    vi.advanceTimersByTime(1000);

    vi.advanceTimersByTime(1000);
    expect(socket.getQuality()).toBe('poor');
    expect(ws.sent.filter((s) => s === 'ping').length).toBe(2);
  });

  it('force-closes the socket with CloseCodes.IDLE once missedPongs reaches maxMissedPongs', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(ws.readyState).toBe(3);
  });

  it('triggers onclose with CloseCodes.IDLE after force-close', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const onClose = vi.fn();
    socket.onClose(onClose);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: CloseCodes.IDLE }));
  });

  it('does not force-close when pong arrives before max is reached', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    ws.emit('pong');
    vi.advanceTimersByTime(1000);

    expect(socket.getState()).toBe('open');
  });
});

describe('keepalive — quality tier transitions', () => {
  it('maps a latency below the excellent threshold to excellent', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 400 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(50);
    ws.emit('pong');

    expect(socket.getQuality()).toBe('excellent');
  });

  it('maps a latency at or above the excellent threshold to good', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 400 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');

    expect(socket.getQuality()).toBe('good');
  });

  it('maps latency in the good range to degraded', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    ws.emit('pong');

    expect(socket.getQuality()).toBe('degraded');
  });

  it('maps latency above the degraded threshold to poor', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(600);
    ws.emit('pong');

    expect(socket.getQuality()).toBe('poor');
  });

  it('deduplicates onQualityChange — does not fire again for the same tier', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
      keepalive({ interval: 1000 }),
    );

    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    // First pong fires once (unknown → excellent). The second, same-tier pong must not.
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    const callsAfterFirst = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('fires onQualityChange(disconnected) when missed pongs force the connection closed', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000, maxMissedPongs: 2 }),
    );
    const tiers: string[] = [];
    socket.onQualityChange((q) => tiers.push(q));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');
    expect(tiers.at(-1)).toBe('good');

    vi.advanceTimersByTime(2900);

    expect(socket.getQuality()).toBe('disconnected');
    expect(tiers.at(-1)).toBe('disconnected');
  });

  it('fires onQualityChange(disconnected, null) on a clean close, not with a stale latency', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );
    const calls: Array<[string, number | null]> = [];
    socket.onQualityChange((q, l) => calls.push([q, l]));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');
    expect(calls.at(-1)).toEqual(['good', 100]);

    ws.serverClose(1000, 'bye');
    expect(calls.at(-1)).toEqual(['disconnected', null]);
  });
});

describe('keepalive — interval zero disables pings', () => {
  it('does not send any ping when interval is 0', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 0 }));

    vi.advanceTimersByTime(60_000);
    const pings = ws.sent.filter((s) => s === 'ping');
    expect(pings.length).toBe(0);
  });

  it('does not force-close even if the socket stays open indefinitely', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 0 }));

    vi.advanceTimersByTime(300_000);
    expect(socket.getState()).toBe('open');
  });
});

describe('keepalive — quality at open and the first measurement', () => {
  it('does not fire onQualityChange at open — it waits for the first measured pong', () => {
    vi.useFakeTimers();
    const socket = client<C>()(connect('wss://test'), keepalive({ interval: 1000 }));
    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    socket.connect();
    MockWebSocket.last().open();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('getQuality() returns the optimistic default and getLatency() is null before any pong', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));
    expect(socket.getQuality()).toBe('excellent');
    expect(socket.getLatency()).toBeNull();
  });

  it('fires the first onQualityChange on the first measured pong (unknown → measured tier)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );
    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(20);
    ws.emit('pong');

    expect(onChange).toHaveBeenCalledWith('excellent', 20);
  });

  it('fires onQualityChange on reconnect when a tier change is detectable', () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      keepalive({ interval: 1000 }),
      reconnection(),
    );
    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    socket.connect();
    const ws1 = MockWebSocket.last();
    ws1.open();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onChange).toHaveBeenCalledWith('poor', null);
  });
});

describe('helpers.forceClose', () => {
  it('calls ws.close with the given code when a live ws exists', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const closeSpy = vi.spyOn(ws, 'close');

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(closeSpy).toHaveBeenCalledWith(CloseCodes.IDLE, 'missed pong');
    expect(socket.getState()).toBe('closed');
  });

  it('is a safe no-op when ws is null mid-loop (the ws?.close optional chain prevents a throw)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    // Spy on close before we null the ws reference, so we can confirm it was
    // never called (the ?.  guard short-circuits when ws is null).
    const closeSpy = vi.spyOn(ws, 'close');

    vi.advanceTimersByTime(1000);

    (socket as unknown as WSKitSocket).ws = null;

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

    // The original ws.close must NOT have been called — the ?.  guard blocked it.
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe('socket.getQuality — state gating', () => {
  it('returns disconnected while the socket is in connecting state', () => {
    const socket = client<C>()(connect('wss://test'), keepalive({ interval: 1000 }));
    socket.connect();
    expect(socket.getQuality()).toBe('disconnected');
  });

  it('returns disconnected while the socket is in reconnecting state', () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      keepalive({ interval: 1000 }),
      reconnection(),
    );
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);
    expect(socket.getState()).toBe('reconnecting');
    expect(socket.getQuality()).toBe('disconnected');
  });

  it('returns the live quality tier while the socket is open', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));

    expect(socket.getState()).toBe('open');
    expect(socket.getQuality()).toBe('excellent');
  });

  it('returns disconnected after the socket is closed', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));
    socket.disconnect();
    expect(socket.getQuality()).toBe('disconnected');
  });
});

describe('quality change event and latency refresh', () => {
  it('getLatency reflects the latest pong even when the tier does not change', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    expect(socket.getLatency()).toBe(10);

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(25);
    ws.emit('pong');
    expect(socket.getLatency()).toBe(25);
  });

  it('does not fire onQualityChange when the pong lands at the same tier', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
      keepalive({ interval: 1000 }),
    );

    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    const callsAfterFirst = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(15);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('fires onQualityChange when the tier genuinely changes', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    const callsAfterExcellent = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(100);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBeGreaterThan(callsAfterExcellent);
    expect(onChange).toHaveBeenLastCalledWith('good', expect.any(Number));
  });
});

describe('forceClose is called exactly once even when onclose is delayed', () => {
  it('interval stops after forceClose — ws.close not called again on next tick', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const closeSpy = vi.spyOn(ws, 'close').mockImplementation((code, reason) => {
      // Simulate a delayed close event: set readyState but do NOT call onclose yet.
      // This means loop.stop() is NOT called, so the interval keeps firing if the bug exists.
      ws.readyState = 3;
      void code;
      void reason;
    });

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // At this point ws.close has been called once. The interval has NOT been cleared yet
    // because onclose hasn't fired (loop.stop() never ran).
    const callsAfterForceClose = closeSpy.mock.calls.length;

    // Advance past another full interval — the loop should have stopped itself after
    // calling forceClose, so ws.close must NOT be called again.
    vi.advanceTimersByTime(1000); // tick 4: should be silent — bug causes a second forceClose here

    expect(closeSpy).toHaveBeenCalledTimes(callsAfterForceClose);
  });
});

describe('onQualityChange reports null latency when no pong was received', () => {
  it('latency passed to onQualityChange is null when going poor via missed pongs', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const onChange = vi.fn<(q: string, l: number | null) => void>();
    (socket.onQualityChange as (cb: (q: string, l: number | null) => void) => () => void)(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onChange).toHaveBeenCalledWith('poor', null);
  });
});

describe('keepalive — quality uses a rolling average of the last samples', () => {
  it('a single slow pong does not flip the tier (the average stays in band)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    let now = 0;
    function pingThenPong(latency: number): void {
      const nextTick = now - (now % 1000) + 1000;
      vi.advanceTimersByTime(nextTick - now);
      vi.advanceTimersByTime(latency);
      ws.emit('pong');
      now = nextTick + latency;
    }

    pingThenPong(20);
    pingThenPong(20);
    pingThenPong(20);
    pingThenPong(20);
    expect(socket.getQuality()).toBe('excellent');

    pingThenPong(300);
    expect(socket.getQuality()).toBe('excellent');
    expect(socket.getLatency()).toBe(300);
  });

  it('a sustained latency rise moves the tier once the window fills with the new samples', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    let now = 0;
    function pingThenPong(latency: number): void {
      const nextTick = now - (now % 1000) + 1000;
      vi.advanceTimersByTime(nextTick - now);
      vi.advanceTimersByTime(latency);
      ws.emit('pong');
      now = nextTick + latency;
    }

    for (let i = 0; i < 5; i++) pingThenPong(10);
    expect(socket.getQuality()).toBe('excellent');

    for (let i = 0; i < 5; i++) pingThenPong(300);
    expect(socket.getQuality()).toBe('degraded');
  });
});

describe('keepalive — latency cleared on missed pong', () => {
  it('reports null latency on the poor change after a previously healthy pong', () => {
    vi.useFakeTimers();
    const { socket } = build(quality(), keepalive({ interval: 1000, maxMissedPongs: 5 }));

    const calls: Array<[string, number | null]> = [];
    socket.onQualityChange((q, l) => calls.push([q, l]));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(45);
    socket.ws?.onmessage?.({ data: 'pong' } as MessageEvent);
    expect(socket.getLatency()).toBe(45);

    vi.advanceTimersByTime(955);
    vi.advanceTimersByTime(1000);

    const last = calls.at(-1);
    expect(last?.[0]).toBe('poor');
    expect(last?.[1]).toBeNull(); // stale 45ms must not be reported with the degradation
    expect(socket.getLatency()).toBeNull();
  });
});

describe('keepalive — quality listener isolation (#20)', () => {
  it('a throwing onQualityChange listener does not block the others and is reported', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 5 }));
    socket.onError((error) => errors.push(error));
    const second = vi.fn();
    socket.onQualityChange(() => {
      throw new Error('listener boom');
    });
    socket.onQualityChange(second);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(second).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
