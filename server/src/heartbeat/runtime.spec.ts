import { describe, expect, it, vi } from 'vitest';
import {
  recordConnectionLatency,
  refreshHeartbeatTimeout,
  scheduleConnectionPing,
  stopConnectionPing,
} from './runtime.ts';

describe('heartbeat/runtime', () => {
  it('refreshes the heartbeat timeout by clearing the previous timer first', () => {
    const callbackByHandle = new Map<string, () => void>();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      callbackByHandle.set('next', callback as () => void);
      return 'next' as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const close = vi.fn();
    const connection = {
      heartbeatTimer: 'old',
      descriptor: { close },
    };

    refreshHeartbeatTimeout(connection, 5_000);

    expect(clearTimeoutSpy).toHaveBeenCalledWith('old');
    expect(connection.heartbeatTimer).toBe('next');

    callbackByHandle.get('next')?.();
    expect(close).toHaveBeenCalledWith(4004, 'Heartbeat timeout');
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('schedules connection pings, downgrades missed pongs to poor, and can stop cleanly', () => {
    const callbackByHandle = new Map<string, () => void>();
    let nextHandle = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      const handle = `timer-${nextHandle++}`;
      callbackByHandle.set(handle, callback as () => void);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const send = vi.fn();
    const connection = {
      pingTimer: undefined as unknown,
      pendingPingSentAt: undefined as number | undefined,
      descriptor: { send },
      quality: 'good' as const,
    };

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    scheduleConnectionPing(connection, 30_000);
    callbackByHandle.get('timer-0')?.();

    expect(send).toHaveBeenCalledWith('ping');
    expect(connection.pendingPingSentAt).toBe(1_000);
    expect(connection.pingTimer).toBe('timer-1');

    now.mockReturnValue(31_000);
    callbackByHandle.get('timer-1')?.();

    expect(connection.quality).toBe('poor');
    expect(connection.pendingPingSentAt).toBe(31_000);

    stopConnectionPing(connection);

    expect(clearTimeoutSpy).toHaveBeenCalledWith('timer-1');
    expect(connection.pingTimer).toBeUndefined();
    expect(connection.pendingPingSentAt).toBeUndefined();
    now.mockRestore();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('stops pinging without throwing when the send races a socket close', () => {
    const callbackByHandle = new Map<string, () => void>();
    let nextHandle = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      const handle = `t-${nextHandle++}`;
      callbackByHandle.set(handle, callback as () => void);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const send = vi.fn(() => {
      throw new Error("Can't call WebSocket send() after close().");
    });
    const connection = {
      pingTimer: undefined as unknown,
      pendingPingSentAt: undefined as number | undefined,
      descriptor: { send },
      quality: 'good' as const,
    };

    scheduleConnectionPing(connection, 1_000);
    // Fire the ping timer; the socket closed in the meantime, so send throws.
    expect(() => callbackByHandle.get('t-0')?.()).not.toThrow();
    expect(send).toHaveBeenCalledWith('ping');
    // The throw must stop the loop: no follow-up timer beyond the original.
    expect(nextHandle).toBe(1);

    setTimeoutSpy.mockRestore();
  });

  it('records a rolling average latency and derives connection quality from it', () => {
    const connection = {
      latency: null,
      quality: 'good' as const,
      pendingPingSentAt: 0,
      recentLatencies: [50, 75, 100, 125],
    };

    recordConnectionLatency(connection, 200);

    expect(connection.recentLatencies).toEqual([50, 75, 100, 125, 200]);
    expect(connection.latency).toBe(110);
    expect(connection.quality).toBe('good');
    expect(connection.pendingPingSentAt).toBeUndefined();
  });

  it('derives quality "excellent" when average latency is below 100ms', () => {
    const connection = {
      latency: null,
      quality: 'good' as 'excellent' | 'good' | 'degraded' | 'poor',
      pendingPingSentAt: 0,
    };

    recordConnectionLatency(connection, 50);

    expect(connection.latency).toBe(50);
    expect(connection.quality).toBe('excellent');
  });

  it('derives quality "degraded" when average latency is between 300ms and 1000ms', () => {
    const connection = {
      latency: null,
      quality: 'good' as 'excellent' | 'good' | 'degraded' | 'poor',
      pendingPingSentAt: 0,
    };

    recordConnectionLatency(connection, 500);

    expect(connection.latency).toBe(500);
    expect(connection.quality).toBe('degraded');
  });

  it('evicts the oldest sample once the window reaches 5 entries', () => {
    const connection = {
      latency: null,
      quality: 'good' as 'excellent' | 'good' | 'degraded' | 'poor',
      pendingPingSentAt: 0,
      recentLatencies: [10, 20, 30, 40, 50],
    };

    // 6th sample: 60ms. The oldest sample (10) should be evicted, leaving [20,30,40,50,60].
    recordConnectionLatency(connection, 60);

    expect(connection.recentLatencies).toEqual([20, 30, 40, 50, 60]);
    expect(connection.recentLatencies).toHaveLength(5);
    expect(connection.latency).toBe(40);
  });

  it('skips update when there is no pending ping', () => {
    const connection = {
      latency: 100,
      quality: 'good' as 'excellent' | 'good' | 'degraded' | 'poor',
      pendingPingSentAt: undefined,
    };

    recordConnectionLatency(connection, 999);

    expect(connection.latency).toBe(100);
    expect(connection.quality).toBe('good');
  });

  it('refreshHeartbeatTimeout does not call clearTimeout when no previous timer exists', () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(
        (() =>
          'new-handle' as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
      );
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const connection = {
      heartbeatTimer: undefined as unknown,
      descriptor: { close: vi.fn() },
    };

    refreshHeartbeatTimeout(connection, 5_000);

    expect(clearTimeoutSpy).not.toHaveBeenCalled();
    expect(connection.heartbeatTimer).toBe('new-handle');
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
