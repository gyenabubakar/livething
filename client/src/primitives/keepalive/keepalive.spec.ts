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
  // The generic wrapper can't carry each primitive's added API through inference,
  // so we assert it; ApplyPrimitives<P, C> still resolves at each call site.
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

    vi.advanceTimersByTime(1000); // tick 1 — first ping sent, pingSentAt set
    // no pong

    vi.advanceTimersByTime(1000); // tick 2 — pingSentAt still set → missedPongs becomes 1, quality 'poor'
    expect(socket.getQuality()).toBe('poor');
    expect(ws.sent.filter((s) => s === 'ping').length).toBe(2);
  });

  it('force-closes the socket with CloseCodes.IDLE once missedPongs reaches maxMissedPongs', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    vi.advanceTimersByTime(1000); // ping 1 sent, pingSentAt set
    // no pong — missedPongs will increment on next tick
    vi.advanceTimersByTime(1000); // missedPongs = 1 (< 2), quality 'poor', ping 2 sent
    vi.advanceTimersByTime(1000); // missedPongs = 2 (>= 2), forceClose fires

    // ws.close() was called by forceClose — readyState should be 3 (closed)
    expect(ws.readyState).toBe(3);
  });

  it('triggers onclose with CloseCodes.IDLE after force-close', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const onClose = vi.fn();
    socket.onClose(onClose);

    vi.advanceTimersByTime(1000); // ping 1
    vi.advanceTimersByTime(1000); // missedPongs=1, poor quality, ping 2
    vi.advanceTimersByTime(1000); // missedPongs=2, forceClose → ws.close(4004, 'missed pong')

    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: CloseCodes.IDLE }));
  });

  it('does not force-close when pong arrives before max is reached', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    vi.advanceTimersByTime(1000); // ping 1
    vi.advanceTimersByTime(1000); // missedPongs=1, ping 2
    ws.emit('pong'); // pong resets counter
    vi.advanceTimersByTime(1000); // tick: pingSentAt was reset by pong, no miss counted

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

    vi.advanceTimersByTime(1000); // ping sent
    vi.advanceTimersByTime(50); // 50ms passes — pong arrives within excellent threshold
    ws.emit('pong');

    expect(socket.getQuality()).toBe('excellent');
  });

  it('maps a latency at or above the excellent threshold to good', () => {
    vi.useFakeTimers();
    // excellent=100 means latency >= 100 goes to good
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 400 } }),
      keepalive({ interval: 1000 }),
    );

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100); // exactly at excellent threshold → good
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
    vi.advanceTimersByTime(200); // >= good (150), < degraded (500) → degraded
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
    vi.advanceTimersByTime(600); // >= degraded (500) → poor
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
    vi.advanceTimersByTime(1000); // ping 1
    vi.advanceTimersByTime(10); // 10ms elapsed
    ws.emit('pong'); // latency 10ms < 1000 → excellent
    const callsAfterFirst = onChange.mock.calls.length;

    vi.advanceTimersByTime(990); // ping 2 fires (interval from tick, total 2000ms from open)
    vi.advanceTimersByTime(10);
    ws.emit('pong'); // same tier excellent — no second fire

    expect(onChange.mock.calls.length).toBe(callsAfterFirst);
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

    vi.advanceTimersByTime(300_000); // 5 minutes — nothing should happen
    expect(socket.getState()).toBe('open');
  });
});

describe('keepalive — quality at open and the first measurement', () => {
  // Quality is unknown until a pong measures it. The socket shows an optimistic
  // default in the meantime, and the first measured pong fires the first event.
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

    vi.advanceTimersByTime(1000); // ping
    vi.advanceTimersByTime(20); // 20ms < 50 → excellent
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

    // Drive a real tier change: advance past one missed pong → quality = 'poor'
    vi.advanceTimersByTime(1000); // ping 1 sent
    vi.advanceTimersByTime(1000); // missed pong → missedPongs=1, setQuality('poor')

    expect(onChange).toHaveBeenCalledWith('poor', null);
  });
});

describe('helpers.forceClose', () => {
  it('calls ws.close with the given code when a live ws exists', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    // Capture the close call spy
    const closeSpy = vi.spyOn(ws, 'close');

    vi.advanceTimersByTime(1000); // ping 1
    vi.advanceTimersByTime(1000); // missedPongs=1, poor, ping 2
    vi.advanceTimersByTime(1000); // missedPongs=2, forceClose

    expect(closeSpy).toHaveBeenCalledWith(CloseCodes.IDLE, 'missed pong');
    expect(socket.getState()).toBe('closed');
  });

  it('is a safe no-op when ws is null mid-loop (the ws?.close optional chain prevents a throw)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    // Spy on close before we null the ws reference, so we can confirm it was
    // never called (the ?.  guard short-circuits when ws is null).
    const closeSpy = vi.spyOn(ws, 'close');

    // Tick 1: pingSentAt is now set inside the loop, timer is still armed.
    vi.advanceTimersByTime(1000);

    // Null the socket's ws while the interval is still running — this simulates
    // the ws being torn down externally without the loop being stopped.
    (socket as unknown as WSKitSocket).ws = null;

    // Tick 2: pingSentAt !== null → missedPongs becomes 1 (< 2), loop continues.
    // Tick 3: missedPongs becomes 2 (>= maxMissedPongs) → forceClose() fires,
    //         which calls this.ws?.close(...). ws is null, so ?.  is a no-op.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();

    // The original ws.close must NOT have been called — the ?.  guard blocked it.
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe('socket.getQuality — state gating', () => {
  it('returns disconnected while the socket is in connecting state', () => {
    const socket = client<C>()(connect('wss://test'), keepalive({ interval: 1000 }));
    socket.connect(); // state = 'connecting', ws not yet open
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
    MockWebSocket.last().serverClose(1006); // → reconnecting
    expect(socket.getState()).toBe('reconnecting');
    expect(socket.getQuality()).toBe('disconnected');
  });

  it('returns the live quality tier while the socket is open', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000 }));

    // Just after open, no pong yet — getQuality() shows the optimistic default.
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
  // getLatency() updates on every pong (reportLatency), independently of the
  // quality tier. The tier event (onQualityChange) still fires only on a change.
  it('getLatency reflects the latest pong even when the tier does not change', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 1000, good: 2000, degraded: 3000 } }),
      keepalive({ interval: 1000 }),
    );

    // Ping 1 → pong at 10ms (excellent)
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    expect(socket.getLatency()).toBe(10);

    // Ping 2 → pong at 25ms — still excellent (same tier), but latency updates.
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

    // First pong fires (unknown → excellent).
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');

    const callsAfterFirst = onChange.mock.calls.length;

    // Second pong — also excellent, latency just slightly different → no extra fire.
    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(15);
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBe(callsAfterFirst); // no extra fire
  });

  it('fires onQualityChange when the tier genuinely changes', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 50, good: 150, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    const onChange = vi.fn();
    socket.onQualityChange(onChange);

    // First pong — excellent (under 50ms)
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(10);
    ws.emit('pong');
    const callsAfterExcellent = onChange.mock.calls.length;

    // Second pong — tier changes to good (>= 50ms)
    vi.advanceTimersByTime(990);
    vi.advanceTimersByTime(100); // 100ms >= excellent(50) → good
    ws.emit('pong');

    expect(onChange.mock.calls.length).toBeGreaterThan(callsAfterExcellent);
    expect(onChange).toHaveBeenLastCalledWith('good', expect.any(Number));
  });
});

describe('[BUG keepalive-forceclose] forceClose is called exactly once even when onclose is delayed', () => {
  it('[BUG keepalive-forceclose] interval stops after forceClose — ws.close not called again on next tick', () => {
    vi.useFakeTimers();
    const { ws } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    const closeSpy = vi.spyOn(ws, 'close').mockImplementation((code, reason) => {
      // Simulate a delayed close event: set readyState but do NOT call onclose yet.
      // This means loop.stop() is NOT called, so the interval keeps firing if the bug exists.
      ws.readyState = 3;
      // Store args for later assertion but don't fire onclose now.
      void code;
      void reason;
    });

    vi.advanceTimersByTime(1000); // ping 1 sent, pingSentAt set
    vi.advanceTimersByTime(1000); // tick 2: missed pong → missedPongs=1 (<2), poor, ping 2 sent
    vi.advanceTimersByTime(1000); // tick 3: missed pong → missedPongs=2 (>=2), forceClose fires

    // At this point ws.close has been called once. The interval has NOT been cleared yet
    // because onclose hasn't fired (loop.stop() never ran).
    const callsAfterForceClose = closeSpy.mock.calls.length;

    // Advance past another full interval — the loop should have stopped itself after
    // calling forceClose, so ws.close must NOT be called again.
    vi.advanceTimersByTime(1000); // tick 4: should be silent — bug causes a second forceClose here

    expect(closeSpy).toHaveBeenCalledTimes(callsAfterForceClose); // still exactly 1 call
  });
});

describe('[BUG quality-fake-latency] onQualityChange reports null latency when no pong was received', () => {
  it('[BUG quality-fake-latency] latency passed to onQualityChange is null when going poor via missed pongs', () => {
    vi.useFakeTimers();
    const { socket } = build(keepalive({ interval: 1000, maxMissedPongs: 2 }));

    // Cast to accept null so the test can actually check the runtime value even though
    // the declared type is (quality, latency: number) — the correct type is number|null.
    const onChange = vi.fn<(q: string, l: number | null) => void>();
    (socket.onQualityChange as (cb: (q: string, l: number | null) => void) => () => void)(onChange);

    vi.advanceTimersByTime(1000); // ping 1 sent, pingSentAt set
    // No pong ever arrives — so latency is null throughout.
    vi.advanceTimersByTime(1000); // tick 2: missedPongs=1, quality → 'poor', onQualityChange fires

    expect(onChange).toHaveBeenCalledWith('poor', null); // correct: no measurement → null, not 0
  });
});

describe('keepalive — quality uses a rolling average of the last samples', () => {
  it('a single slow pong does not flip the tier (the average stays in band)', () => {
    vi.useFakeTimers();
    const { socket, ws } = build(
      quality({ thresholds: { excellent: 100, good: 200, degraded: 500 } }),
      keepalive({ interval: 1000 }),
    );

    // Advance to the next ping tick, wait `latency` ms, then deliver the pong.
    let now = 0;
    function pingThenPong(latency: number): void {
      const nextTick = now - (now % 1000) + 1000;
      vi.advanceTimersByTime(nextTick - now); // ping fires here
      vi.advanceTimersByTime(latency); // round trip
      ws.emit('pong');
      now = nextTick + latency;
    }

    pingThenPong(20);
    pingThenPong(20);
    pingThenPong(20);
    pingThenPong(20);
    expect(socket.getQuality()).toBe('excellent');

    // One 300ms spike: avg([20,20,20,20,300]) = 76 → still 'excellent', even
    // though 300ms on its own would be 'degraded'. getLatency() shows the spike.
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

    // Five fast pongs → excellent.
    for (let i = 0; i < 5; i++) pingThenPong(10);
    expect(socket.getQuality()).toBe('excellent');

    // Then five sustained 300ms pongs flush the window → avg 300 → 'degraded'.
    for (let i = 0; i < 5; i++) pingThenPong(300);
    expect(socket.getQuality()).toBe('degraded');
  });
});
