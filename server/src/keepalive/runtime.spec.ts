import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import { createKeepaliveMonitor } from './runtime.ts';

type MonitorPort = Pick<
  EngineAccess,
  'refreshConnectionIdleTimeout' | 'sendPing' | 'setConnectionLatency'
>;

const TIMINGS = { pingIntervalMs: 30_000, idleTimeoutMs: 60_000 };

function createPort(overrides: { sendPing?: MonitorPort['sendPing'] } = {}) {
  return {
    sendPing: vi.fn(overrides.sendPing),
    setConnectionLatency: vi.fn<MonitorPort['setConnectionLatency']>(),
    refreshConnectionIdleTimeout: vi.fn<MonitorPort['refreshConnectionIdleTimeout']>(),
  };
}

/** The latest quality the monitor reported for a connection. */
function lastQuality(port: ReturnType<typeof createPort>): string | undefined {
  return port.setConnectionLatency.mock.calls.at(-1)?.[2];
}

/** The latest latency the monitor reported for a connection. */
function lastLatency(port: ReturnType<typeof createPort>): number | null | undefined {
  return port.setConnectionLatency.mock.calls.at(-1)?.[1];
}

/** Let one ping interval pass, firing the ping timer once. */
function passOnePingInterval(): void {
  vi.advanceTimersByTime(TIMINGS.pingIntervalMs);
}

/** Answer the ping that is currently outstanding, after `rtt` milliseconds. */
function answerPongAfter(
  monitor: ReturnType<typeof createKeepaliveMonitor>,
  connectionId: string,
  rtt: number,
): void {
  vi.setSystemTime(Date.now() + rtt);
  monitor.recordPong(connectionId);
}

describe('keepalive/runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('watch', () => {
    it('opens the idle window and starts pinging', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');

      expect(port.refreshConnectionIdleTimeout).toHaveBeenCalledWith('c1', 60_000);
      expect(port.sendPing).not.toHaveBeenCalled();

      passOnePingInterval();
      expect(port.sendPing).toHaveBeenCalledWith('c1');
    });

    it('does nothing when supervision is off: no ping, no idle timer', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, false);

      monitor.watch('c1');
      vi.advanceTimersByTime(TIMINGS.pingIntervalMs * 10);

      // A `setTimeout` idle timer would itself keep the connection's Durable
      // Object alive, defeating hibernation, and would fire with nothing left
      // to refresh it — closing a client that never went away.
      expect(port.refreshConnectionIdleTimeout).not.toHaveBeenCalled();
      expect(port.sendPing).not.toHaveBeenCalled();
    });

    it('is a no-op for a connection already being watched', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      monitor.watch('c1');
      passOnePingInterval();

      expect(port.sendPing).toHaveBeenCalledTimes(1);
    });

    it('keeps pinging on every interval', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 20);
      passOnePingInterval();

      expect(port.sendPing).toHaveBeenCalledTimes(2);
    });

    it('pings each watched connection on its own timer', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      monitor.watch('c2');
      passOnePingInterval();

      expect(port.sendPing).toHaveBeenCalledWith('c1');
      expect(port.sendPing).toHaveBeenCalledWith('c2');
    });
  });

  describe('touch', () => {
    it('reopens the idle window', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      port.refreshConnectionIdleTimeout.mockClear();
      monitor.touch('c1');

      expect(port.refreshConnectionIdleTimeout).toHaveBeenCalledWith('c1', 60_000);
    });

    it('reopens the window even for a connection it never watched', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.touch('stranger');

      expect(port.refreshConnectionIdleTimeout).toHaveBeenCalledWith('stranger', 60_000);
    });

    it('never arms the idle timer when supervision is off', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, false);

      monitor.touch('c1');

      expect(port.refreshConnectionIdleTimeout).not.toHaveBeenCalled();
    });
  });

  describe('recordPong', () => {
    it('reports the round-trip time and derives quality from it', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 50);

      expect(port.setConnectionLatency).toHaveBeenCalledWith('c1', 50, 'excellent');
    });

    it.each([
      [50, 'excellent'],
      [150, 'good'],
      [500, 'degraded'],
      [1_500, 'poor'],
    ])('maps a %dms round-trip to quality "%s"', (rtt, quality) => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', rtt);

      expect(lastLatency(port)).toBe(rtt);
      expect(lastQuality(port)).toBe(quality);
    });

    it('averages the round-trip over recent samples', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 100);
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 200);

      expect(lastLatency(port)).toBe(150);
    });

    it('keeps only the five most recent samples', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      for (const rtt of [10, 20, 30, 40, 50]) {
        passOnePingInterval();
        answerPongAfter(monitor, 'c1', rtt);
      }

      expect(lastLatency(port)).toBe(30);

      // A sixth sample drops the 10 and averages [20, 30, 40, 50, 60].
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 60);
      expect(lastLatency(port)).toBe(40);
    });

    it('ignores a pong when no ping is outstanding', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      monitor.recordPong('c1');

      expect(port.setConnectionLatency).not.toHaveBeenCalled();
    });

    it('ignores a second pong answering the same ping', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 40);
      port.setConnectionLatency.mockClear();

      monitor.recordPong('c1');

      expect(port.setConnectionLatency).not.toHaveBeenCalled();
    });

    it('ignores a pong from a connection it never watched', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.recordPong('stranger');

      expect(port.setConnectionLatency).not.toHaveBeenCalled();
    });
  });

  describe('an unanswered ping', () => {
    it('downgrades quality to poor while keeping the last measured latency', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 50);
      expect(lastQuality(port)).toBe('excellent');

      // Second ping goes out and is never answered; the third ping notices.
      passOnePingInterval();
      passOnePingInterval();

      expect(lastLatency(port)).toBe(50);
      expect(lastQuality(port)).toBe('poor');
    });

    it('does not report a quality before any ping has gone unanswered', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();

      expect(port.setConnectionLatency).not.toHaveBeenCalled();
    });
  });

  describe('forget', () => {
    it('cancels the ping timer', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      monitor.forget('c1');
      vi.advanceTimersByTime(TIMINGS.pingIntervalMs * 5);

      expect(port.sendPing).not.toHaveBeenCalled();
    });

    it('drops the latency samples, so a re-watch starts fresh', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 1_000);
      monitor.forget('c1');
      port.setConnectionLatency.mockClear();

      monitor.watch('c1');
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 40);

      expect(lastLatency(port)).toBe(40);
    });

    it('is a no-op for a connection it never watched', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);

      expect(() => monitor.forget('stranger')).not.toThrow();
    });
  });

  describe('a late pong', () => {
    it('is timed against the ping it answers, not a newer one', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 100);

      expect(lastLatency(port)).toBe(30_100);
      expect(lastQuality(port)).toBe('poor');
    });

    it('still times a healthy pong against its own ping', () => {
      const port = createPort();
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 100);

      expect(lastLatency(port)).toBe(100);
    });
  });

  describe('one ping at a time', () => {
    it('sends no new ping while one is unanswered', () => {
      const port = createPort({ sendPing: () => true });
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      for (let i = 0; i < 4; i += 1) passOnePingInterval();

      expect(port.sendPing).toHaveBeenCalledTimes(1);
    });

    it('counts every interval with no pong as missed', () => {
      const port = createPort({ sendPing: () => true });
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      passOnePingInterval();
      passOnePingInterval();

      expect(port.setConnectionLatency.mock.calls).toEqual([
        ['c1', null, 'poor'],
        ['c1', null, 'poor'],
      ]);
    });

    it('pings again on the next interval after a late pong', () => {
      const port = createPort({ sendPing: () => true });
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 100);
      passOnePingInterval();

      expect(port.sendPing).toHaveBeenCalledTimes(2);
    });

    it('times the pong after a late one against its own ping, not an interval off', () => {
      const port = createPort({ sendPing: () => true });
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 100);
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 50);

      // The average of the real samples, 30_100 and 50.
      expect(lastLatency(port)).toBe(15_075);
    });

    it('treats a ping that was not sent as not outstanding', () => {
      const port = createPort({ sendPing: () => false });
      const monitor = createKeepaliveMonitor(port, TIMINGS, true);
      monitor.watch('c1');

      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 10);

      expect(port.setConnectionLatency).not.toHaveBeenCalled();
    });
  });

  it('stops pinging without throwing when the send races a socket close', () => {
    const port = createPort({
      sendPing: () => {
        throw new Error("Can't call WebSocket send() after close().");
      },
    });
    const monitor = createKeepaliveMonitor(port, TIMINGS, true);

    monitor.watch('c1');
    expect(() => passOnePingInterval()).not.toThrow();
    expect(port.sendPing).toHaveBeenCalledTimes(1);

    // The throw ends the loop: no follow-up ping is ever scheduled.
    vi.advanceTimersByTime(TIMINGS.pingIntervalMs * 5);
    expect(port.sendPing).toHaveBeenCalledTimes(1);
  });

  it('stops pinging once the connection is gone from the registry, leaving no timer pending', () => {
    // `sendPing` looks the connection up by id and can only send while it is
    // still registered. Model both outcomes: sent while it is there, not sent
    // once teardown has removed it.
    let registered = true;
    const port = createPort({ sendPing: () => registered });
    const monitor = createKeepaliveMonitor(port, TIMINGS, true);

    monitor.watch('c1');
    for (let i = 0; i < 3; i += 1) {
      passOnePingInterval();
      answerPongAfter(monitor, 'c1', 0);
    }

    expect(port.sendPing).toHaveBeenCalledTimes(3);

    // Teardown removes the connection from the registry without ever
    // calling monitor.forget('c1') — teardown is still in flight.
    registered = false;

    for (let i = 0; i < 10; i += 1) passOnePingInterval();

    // Trying to send is the only way to learn the connection is gone, so one
    // further attempt is expected. What must not happen is a fourth timer.
    expect(port.sendPing).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
