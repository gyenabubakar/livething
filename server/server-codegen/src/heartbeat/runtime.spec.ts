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
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        callbackByHandle.set('next', callback);
        return 'next';
      }),
      clearTimeout: vi.fn(),
    };
    const close = vi.fn();
    const connection = {
      heartbeatTimer: 'old',
      descriptor: { close },
    };

    refreshHeartbeatTimeout(timers, connection, 5_000);

    expect(timers.clearTimeout).toHaveBeenCalledWith('old');
    expect(connection.heartbeatTimer).toBe('next');

    callbackByHandle.get('next')?.();
    expect(close).toHaveBeenCalledWith(4004, 'Heartbeat timeout');
  });

  it('schedules connection pings, downgrades missed pongs to poor, and can stop cleanly', () => {
    const callbackByHandle = new Map<string, () => void>();
    let nextHandle = 0;
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        const handle = `timer-${nextHandle++}`;
        callbackByHandle.set(handle, callback);
        return handle;
      }),
      clearTimeout: vi.fn(),
    };
    const send = vi.fn();
    const connection = {
      pingTimer: undefined as unknown,
      pendingPingSentAt: undefined as number | undefined,
      descriptor: { send },
      quality: 'good' as const,
    };

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    scheduleConnectionPing(timers, connection, 30_000);
    callbackByHandle.get('timer-0')?.();

    expect(send).toHaveBeenCalledWith('ping');
    expect(connection.pendingPingSentAt).toBe(1_000);
    expect(connection.pingTimer).toBe('timer-1');

    now.mockReturnValue(31_000);
    callbackByHandle.get('timer-1')?.();

    expect(connection.quality).toBe('poor');
    expect(connection.pendingPingSentAt).toBe(31_000);

    stopConnectionPing(timers, connection);

    expect(timers.clearTimeout).toHaveBeenCalledWith('timer-1');
    expect(connection.pingTimer).toBeUndefined();
    expect(connection.pendingPingSentAt).toBeUndefined();
    now.mockRestore();
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
});
