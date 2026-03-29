import { Keepalive } from '@/socket/keepalive.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeepaliveOptions } from '@/socket/keepalive.ts';
import type { ConnectionQuality } from '@/types.ts';

function createKeepalive(
  overrides: Partial<KeepaliveOptions> = {},
  callbacks: {
    sendPing?: (msg: string) => void;
    forceClose?: () => void;
    onQualityChange?: (quality: ConnectionQuality, latency: number) => void;
  } = {},
) {
  const opts: KeepaliveOptions = {
    pingInterval: 1000,
    ...overrides,
  };

  const cbs = {
    sendPing: callbacks.sendPing ?? vi.fn(),
    forceClose: callbacks.forceClose ?? vi.fn(),
    onQualityChange: callbacks.onQualityChange ?? vi.fn(),
  };

  const keepalive = new Keepalive(opts, cbs);
  return { keepalive, callbacks: cbs };
}

describe('Keepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Start / Stop ──────────────────────────────────────────

  it('sends ping at the configured interval', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000);
    expect(callbacks.sendPing).toHaveBeenCalledTimes(1);
    expect(callbacks.sendPing).toHaveBeenCalledWith('ping');

    vi.advanceTimersByTime(1000);
    expect(callbacks.sendPing).toHaveBeenCalledTimes(2);

    keepalive.stop();
  });

  it('uses custom pingMessage', () => {
    const { keepalive, callbacks } = createKeepalive({ pingMessage: 'heartbeat' });
    keepalive.start();

    vi.advanceTimersByTime(1000);
    expect(callbacks.sendPing).toHaveBeenCalledWith('heartbeat');

    keepalive.stop();
  });

  it('does not start when pingInterval is 0', () => {
    const { keepalive, callbacks } = createKeepalive({ pingInterval: 0 });
    keepalive.start();

    vi.advanceTimersByTime(5000);
    expect(callbacks.sendPing).not.toHaveBeenCalled();
  });

  it('stop clears the ping timer', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();
    keepalive.stop();

    vi.advanceTimersByTime(5000);
    expect(callbacks.sendPing).not.toHaveBeenCalled();
  });

  it('start resets state from a previous session', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    // Miss a pong
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // Restart — should reset missed count
    keepalive.start();
    expect(keepalive.getLatency()).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(callbacks.forceClose).not.toHaveBeenCalled();

    keepalive.stop();
  });

  // ── Latency measurement ───────────────────────────────────

  it('measures latency on pong', () => {
    const { keepalive } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000); // ping sent at t=1000
    vi.advanceTimersByTime(50); // pong arrives 50ms later
    keepalive.onPong();

    expect(keepalive.getLatency()).toBe(50);

    keepalive.stop();
  });

  it('ignores pong when no ping is pending', () => {
    const { keepalive } = createKeepalive();
    keepalive.start();

    keepalive.onPong(); // no ping sent yet
    expect(keepalive.getLatency()).toBeNull();

    keepalive.stop();
  });

  // ── Quality tiers ─────────────────────────────────────────

  it('reports excellent quality for low latency', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(30);
    keepalive.onPong();

    expect(keepalive.getQuality()).toBe('excellent');
    // Quality started at excellent, so no change event
    expect(callbacks.onQualityChange).toHaveBeenCalledTimes(1); // initial set to excellent on start
    keepalive.stop();
  });

  it('reports good quality for moderate latency', () => {
    const { keepalive } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(150);
    keepalive.onPong();

    expect(keepalive.getQuality()).toBe('good');
    keepalive.stop();
  });

  it('reports degraded quality for high latency', () => {
    const { keepalive } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(500);
    keepalive.onPong();

    expect(keepalive.getQuality()).toBe('degraded');
    keepalive.stop();
  });

  it('reports poor quality for very high latency', () => {
    const { keepalive } = createKeepalive({ pingInterval: 5000 });
    keepalive.start();

    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(1500);
    keepalive.onPong();

    expect(keepalive.getQuality()).toBe('poor');
    keepalive.stop();
  });

  it('uses custom quality thresholds', () => {
    const { keepalive } = createKeepalive({
      qualityThresholds: { excellent: 50, good: 150, degraded: 500 },
    });
    keepalive.start();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(80);
    keepalive.onPong();

    expect(keepalive.getQuality()).toBe('good');
    keepalive.stop();
  });

  it('emits qualityChange on tier transitions', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    // First pong: excellent → good
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    keepalive.onPong();

    expect(callbacks.onQualityChange).toHaveBeenCalledWith('good', 200);

    keepalive.stop();
  });

  it('does not emit qualityChange when tier stays the same', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    // First pong at 200ms (good)
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(200);
    keepalive.onPong();

    const callCount = (callbacks.onQualityChange as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second pong also at ~200ms (still good)
    vi.advanceTimersByTime(800); // rest of interval
    vi.advanceTimersByTime(200);
    keepalive.onPong();

    expect((callbacks.onQualityChange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callCount,
    );

    keepalive.stop();
  });

  // ── Missed pong detection ─────────────────────────────────

  it('degrades to poor on first missed pong', () => {
    const { keepalive, callbacks } = createKeepalive();
    keepalive.start();

    // First tick: ping sent
    vi.advanceTimersByTime(1000);
    // Second tick: no pong received → missed
    vi.advanceTimersByTime(1000);

    expect(keepalive.getQuality()).toBe('poor');
    expect(callbacks.onQualityChange).toHaveBeenCalledWith('poor', 0);

    keepalive.stop();
  });

  it('force-closes after maxMissedPongs', () => {
    const { keepalive, callbacks } = createKeepalive({ maxMissedPongs: 2 });
    keepalive.start();

    vi.advanceTimersByTime(1000); // ping 1 sent
    vi.advanceTimersByTime(1000); // tick 2: 1 missed, ping 2 sent
    expect(callbacks.forceClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // tick 3: 2 missed → force close
    expect(callbacks.forceClose).toHaveBeenCalledTimes(1);

    keepalive.stop();
  });

  it('respects custom maxMissedPongs', () => {
    const { keepalive, callbacks } = createKeepalive({ maxMissedPongs: 3 });
    keepalive.start();

    vi.advanceTimersByTime(1000); // ping 1
    vi.advanceTimersByTime(1000); // 1 missed
    vi.advanceTimersByTime(1000); // 2 missed
    expect(callbacks.forceClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // 3 missed → force close
    expect(callbacks.forceClose).toHaveBeenCalledTimes(1);

    keepalive.stop();
  });

  it('resets missed pong count on pong received', () => {
    const { keepalive, callbacks } = createKeepalive({ maxMissedPongs: 2 });
    keepalive.start();

    // Miss one
    vi.advanceTimersByTime(1000); // ping sent
    vi.advanceTimersByTime(1000); // 1 missed, new ping sent

    // Pong arrives for second ping
    vi.advanceTimersByTime(50);
    keepalive.onPong();

    // Next tick should not force close (counter was reset)
    vi.advanceTimersByTime(950); // complete the interval
    vi.advanceTimersByTime(1000); // 1 missed again
    expect(callbacks.forceClose).not.toHaveBeenCalled();

    keepalive.stop();
  });

  // ── Default state ─────────────────────────────────────────

  it('starts with disconnected quality and null latency', () => {
    const { keepalive } = createKeepalive();
    expect(keepalive.getQuality()).toBe('disconnected');
    expect(keepalive.getLatency()).toBeNull();
  });

  it('resets to disconnected quality and null latency on stop', () => {
    const { keepalive } = createKeepalive();
    keepalive.start();

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(50);
    keepalive.onPong();
    expect(keepalive.getLatency()).toBe(50);

    keepalive.stop();
    expect(keepalive.getQuality()).toBe('disconnected');
    expect(keepalive.getLatency()).toBeNull();
  });
});
