import { CloseCodes, LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyPrimitives, Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
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
    expect(socket.quality.get()).toBe('poor');
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

    expect(socket.state.get()).toBe('open');
  });
});

describe('keepalive — quality tier transitions', () => {
  it('maps a latency below the excellent threshold to excellent', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 100, good: 200, degraded: 400 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(50);
    ws.emit('pong');

    expect(socket.quality.get()).toBe('excellent');
  });

  it('maps a latency at or above the excellent threshold to good', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 100, good: 200, degraded: 400 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');

    expect(socket.quality.get()).toBe('good');
  });

  it('maps latency in the good range to degraded', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    ws.emit('pong');

    expect(socket.quality.get()).toBe('degraded');
  });

  it('maps latency above the degraded threshold to poor', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(600);
    ws.emit('pong');

    expect(socket.quality.get()).toBe('poor');
  });

  it('deduplicates the quality store — does not fire again for the same tier', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
    );

    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    const callsAfterFirst = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('moves the quality store to disconnected when missed pongs force the connection closed', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({
        interval: 1000,
        maxMissedPongs: 2,
        thresholds: { excellent: 50, good: 150, degraded: 500 },
      }),
    );
    const tiers: string[] = [];
    socket.quality.subscribe((q) => tiers.push(q));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');
    expect(tiers.at(-1)).toBe('good');

    vi.advanceTimersByTime(2900);

    expect(socket.quality.get()).toBe('disconnected');
    expect(tiers.at(-1)).toBe('disconnected');
  });

  it('goes disconnected with null latency on a clean close, not with a stale latency', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );
    const tiers: string[] = [];
    const latencies: Array<number | null> = [];
    socket.quality.subscribe((q) => tiers.push(q));

    socket.latency.subscribe((l) => latencies.push(l));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    ws.emit('pong');
    expect(tiers.at(-1)).toBe('good');
    expect(latencies.at(-1)).toBe(100);

    ws.serverClose(1000, 'bye');
    expect(tiers.at(-1)).toBe('disconnected');
    expect(latencies.at(-1)).toBeNull();
  });
});

describe('keepalive — default thresholds match the server', () => {
  it.each([
    [99, 'excellent'],
    [100, 'good'],
    [299, 'good'],
    [300, 'degraded'],
    [999, 'degraded'],
    [1000, 'poor'],
  ])('maps a %i ms round trip to %s', (latencyMs, tier) => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 5000 }));

    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(latencyMs);
    ws.emit('pong');

    expect(socket.quality.get()).toBe(tier);
  });
});

describe('keepalive — interval must be positive', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws a LiveThingConfigError for interval %s',
    (interval) => {
      expect(() => keepalive({ interval })).toThrow(LiveThingConfigError);
      expect(() => keepalive({ interval })).toThrow(/leave keepalive\(\) out/);
    },
  );

  it('accepts an interval of 1', () => {
    expect(() => keepalive({ interval: 1 })).not.toThrow();
  });
});

describe('keepalive — quality at open and the first measurement', () => {
  it('does not publish a quality tier at open — it waits for the first measured pong', () => {
    vi.useFakeTimers();
    const socket = client<C>()(connect('wss://test'), keepalive({ interval: 1000 }));
    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    socket.connect();
    MockWebSocket.last().open();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('quality.get() starts disconnected and latency.get() is null before any pong', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));
    expect(socket.quality.get()).toBe('disconnected');
    expect(socket.latency.get()).toBeNull();
  });

  it('publishes the first quality tier on the first measured pong (disconnected → measured tier)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );
    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(20);
    ws.emit('pong');

    expect(onChange).toHaveBeenCalledWith('excellent');
    expect(socket.latency.get()).toBe(20);
  });

  it('publishes a new quality tier on reconnect when a tier change is detectable', () => {
    vi.useFakeTimers();
    const socket = client<C>()(
      connect('wss://test'),
      keepalive({ interval: 1000 }),
      reconnection(),
    );
    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    socket.connect();
    const ws1 = MockWebSocket.last();
    ws1.open();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onChange).toHaveBeenCalledWith('poor');
    expect(socket.latency.get()).toBeNull();
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
    expect(socket.state.get()).toBe('closed');
  });

  it('is a safe no-op when ws is null mid-loop (the ws?.close optional chain prevents a throw)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    // Spy on close before we null the ws reference, so we can confirm it was
    // never called (the ?.  guard short-circuits when ws is null).
    const closeSpy = vi.spyOn(ws, 'close');

    vi.advanceTimersByTime(1000);

    (socket as unknown as LiveThingSocket).ws = null;

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

    // The original ws.close must NOT have been called — the ?.  guard blocked it.
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe('socket.quality — state gating', () => {
  it('returns disconnected while the socket is in connecting state', () => {
    const socket = client<C>()(connect('wss://test'), keepalive({ interval: 1000 }));
    socket.connect();
    expect(socket.quality.get()).toBe('disconnected');
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

    expect(socket.state.get()).toBe('reconnecting');
    expect(socket.quality.get()).toBe('disconnected');
  });

  it('returns disconnected while open until the first pong is measured', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));

    expect(socket.state.get()).toBe('open');
    expect(socket.quality.get()).toBe('disconnected');
  });

  it('returns the live quality tier once a pong has been measured while open', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    expect(socket.state.get()).toBe('open');
    expect(socket.quality.get()).toBe('excellent');
  });

  it('returns disconnected after the socket is closed', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));
    socket.disconnect();
    expect(socket.quality.get()).toBe('disconnected');
  });
});

describe('quality change event and latency refresh', () => {
  it('getLatency reflects the latest pong even when the tier does not change', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    expect(socket.latency.get()).toBe(10);

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(25);
    ws.emit('pong');
    expect(socket.latency.get()).toBe(25);
  });

  it('does not publish a quality tier when the pong lands at the same tier', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
    );

    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    const callsAfterFirst = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(15);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
  });

  it('publishes a quality tier when the tier genuinely changes', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 50, good: 150, degraded: 500 } }),
    );

    const onChange = vi.fn();
    socket.quality.subscribe(onChange);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    const callsAfterExcellent = onChange.mock.calls.length;

    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(100);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBeGreaterThan(callsAfterExcellent);
    expect(onChange).toHaveBeenLastCalledWith('good');
  });
});

describe('forceClose is called exactly once even when onclose is delayed', () => {
  it('interval stops after forceClose — ws.close not called again on next tick', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const closeSpy = vi.spyOn(ws, 'close').mockImplementation((code, reason) => {
      // Simulate a delayed close event: set readyState but do NOT call onclose yet.
      // This means loop.stop() is NOT called, so the interval keeps firing unless the loop stops itself.
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
    vi.advanceTimersByTime(1000); // tick 4: should be silent, no second forceClose

    expect(closeSpy).toHaveBeenCalledTimes(callsAfterForceClose);
  });
});

describe('latency store is null when no pong was received', () => {
  it('latency is null and quality is poor when going poor via missed pongs', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const onQuality = vi.fn();
    const onLatency = vi.fn();
    socket.quality.subscribe(onQuality);
    socket.latency.subscribe(onLatency);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onQuality).toHaveBeenCalledWith('poor');
    expect(socket.latency.get()).toBeNull();
  });
});

describe('keepalive — quality uses a rolling average of the last samples', () => {
  it('a single slow pong does not flip the tier (the average stays in band)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 100, good: 200, degraded: 500 } }),
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
    expect(socket.quality.get()).toBe('excellent');

    pingThenPong(300);
    expect(socket.quality.get()).toBe('excellent');
    expect(socket.latency.get()).toBe(300);
  });

  it('a sustained latency rise moves the tier once the window fills with the new samples', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      keepalive({ interval: 1000, thresholds: { excellent: 100, good: 200, degraded: 500 } }),
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
    expect(socket.quality.get()).toBe('excellent');

    for (let i = 0; i < 5; i++) pingThenPong(300);
    expect(socket.quality.get()).toBe('degraded');
  });
});

describe('keepalive — latency cleared on missed pong', () => {
  it('clears latency to null on the poor change after a previously healthy pong', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 5 }));

    const tiers: string[] = [];
    const latencies: Array<number | null> = [];
    socket.quality.subscribe((q) => tiers.push(q));
    socket.latency.subscribe((l) => latencies.push(l));

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(45);
    socket.ws?.onmessage?.({ data: 'pong' } as MessageEvent);
    expect(socket.latency.get()).toBe(45);

    vi.advanceTimersByTime(955);
    vi.advanceTimersByTime(1000);

    expect(tiers.at(-1)).toBe('poor');
    expect(latencies.at(-1)).toBeNull();
    expect(socket.latency.get()).toBeNull();
  });
});

describe('keepalive — quality listener isolation', () => {
  it('a throwing quality-store listener does not block the others and is reported', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 5 }));
    socket.onError((error) => errors.push(error));
    const second = vi.fn();

    socket.quality.subscribe(() => {
      throw new Error('listener boom');
    });
    socket.quality.subscribe(second);

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(second).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
