/* oxlint-disable @typescript-eslint/no-explicit-any -- testing internal lazy mode state */
import { Socket } from '@/socket/socket.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullSocketOptions } from '@/options.ts';

interface TestContract {
  incoming: { test: { data: string }; a: unknown; b: unknown; test2: unknown };
  outgoing: { test: { data: string } };
}

function createLazySocket(overrides: Partial<FullSocketOptions<TestContract>> = {}) {
  const opts: FullSocketOptions<TestContract> = {
    lazy: true,
    lazyIdleTimeout: 1000,
    ...overrides,
  };
  const socket = new Socket<TestContract>('ws://localhost', opts, []);
  // Stub _openConnection to avoid real WebSocket
  vi.spyOn(socket as any, '_openConnection').mockImplementation(() => {});
  return socket;
}

describe('Lazy mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── _ensureConnected ──────────────────────────────────────

  it('connect() is not called automatically when lazy is true', () => {
    const socket = createLazySocket();
    expect(socket.getState()).toBe('closed');
    expect((socket as any)._openConnection).not.toHaveBeenCalled();
  });

  it('_ensureConnected triggers connect when closed', () => {
    const socket = createLazySocket();
    socket._ensureConnected();

    expect((socket as any)._openConnection).toHaveBeenCalledTimes(1);
  });

  it('_ensureConnected is a no-op when not in lazy mode', () => {
    const socket = createLazySocket({ lazy: false });
    socket._ensureConnected();

    expect((socket as any)._openConnection).not.toHaveBeenCalled();
  });

  it('_ensureConnected is a no-op when already connecting', () => {
    const socket = createLazySocket();
    socket._state = 'connecting';
    socket._ensureConnected();

    expect((socket as any)._openConnection).not.toHaveBeenCalled();
  });

  it('_ensureConnected is a no-op when already open', () => {
    const socket = createLazySocket();
    socket._state = 'open';
    socket._ensureConnected();

    expect((socket as any)._openConnection).not.toHaveBeenCalled();
  });

  it('_ensureConnected is a no-op when reconnecting', () => {
    const socket = createLazySocket();
    socket._state = 'reconnecting';
    socket._ensureConnected();

    expect((socket as any)._openConnection).not.toHaveBeenCalled();
  });

  // ── on() triggers lazy connect ────────────────────────────

  it('on() triggers lazy connect', () => {
    const socket = createLazySocket();
    socket.on('test', vi.fn());

    expect((socket as any)._openConnection).toHaveBeenCalledTimes(1);
  });

  it('send() triggers lazy connect', () => {
    const socket = createLazySocket();
    socket.send('test', { data: '' });

    expect((socket as any)._openConnection).toHaveBeenCalledTimes(1);
  });

  // ── Consumer tracking ─────────────────────────────────────

  it('on() increments consumer count', () => {
    const socket = createLazySocket();
    socket.on('a', vi.fn());
    socket.on('b', vi.fn());

    expect(socket._lazyConsumers).toBe(2);
  });

  it('unsubscribing decrements consumer count', () => {
    const socket = createLazySocket();
    const unsub1 = socket.on('a', vi.fn());
    const unsub2 = socket.on('b', vi.fn());

    unsub1();
    expect(socket._lazyConsumers).toBe(1);

    unsub2();
    expect(socket._lazyConsumers).toBe(0);
  });

  it('consumer count never goes below 0', () => {
    const socket = createLazySocket();
    socket._lazyRelease();
    socket._lazyRelease();

    expect(socket._lazyConsumers).toBe(0);
  });

  // ── Idle timeout ──────────────────────────────────────────

  it('starts idle timer when last consumer unsubscribes while open', () => {
    const socket = createLazySocket();
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    // Idle timer should be set
    expect(socket._lazyIdleTimer).not.toBeNull();
  });

  it('disconnects after idle timeout', () => {
    const socket = createLazySocket({ lazyIdleTimeout: 500 });
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    vi.advanceTimersByTime(500);
    expect(socket.getState()).toBe('closed');
  });

  it('does not disconnect before idle timeout', () => {
    const socket = createLazySocket({ lazyIdleTimeout: 500 });
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    vi.advanceTimersByTime(400);
    expect(socket.getState()).toBe('open');
  });

  it('cancels idle timer when new consumer subscribes', () => {
    const socket = createLazySocket({ lazyIdleTimeout: 500 });
    socket._state = 'open';

    const unsub1 = socket.on('a', vi.fn());
    unsub1(); // idle timer starts

    // New consumer before timeout
    socket.on('b', vi.fn());

    vi.advanceTimersByTime(600);
    // Should NOT have disconnected
    expect(socket.getState()).toBe('open');
  });

  it('does not start idle timer when not in lazy mode', () => {
    const socket = createLazySocket({ lazy: false });
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    expect(socket._lazyIdleTimer).toBeNull();
  });

  it('does not start idle timer when consumers remain', () => {
    const socket = createLazySocket();
    socket._state = 'open';

    const unsub1 = socket.on('a', vi.fn());
    socket.on('b', vi.fn());

    unsub1(); // one consumer remains

    expect(socket._lazyIdleTimer).toBeNull();
  });

  it('does not start idle timer when socket is not open', () => {
    const socket = createLazySocket();
    // state is 'closed'

    const unsub = socket.on('test', vi.fn());
    unsub();

    expect(socket._lazyIdleTimer).toBeNull();
  });

  it('clears idle timer on disconnect', () => {
    const socket = createLazySocket();
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub(); // idle timer starts

    socket.disconnect();
    expect(socket._lazyIdleTimer).toBeNull();
  });

  // ── Re-connection after idle ──────────────────────────────

  it('re-connects when on() is called after idle disconnect', () => {
    const socket = createLazySocket({ lazyIdleTimeout: 500 });
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    vi.advanceTimersByTime(500); // idle disconnect
    expect(socket.getState()).toBe('closed');

    (socket as any)._openConnection.mockClear();
    socket.on('test2', vi.fn()); // should trigger reconnect

    expect((socket as any)._openConnection).toHaveBeenCalledTimes(1);
  });

  it('uses default lazyIdleTimeout of 10s', () => {
    const socket = createLazySocket({ lazyIdleTimeout: undefined });
    socket._state = 'open';

    const unsub = socket.on('test', vi.fn());
    unsub();

    vi.advanceTimersByTime(9999);
    expect(socket.getState()).toBe('open');

    vi.advanceTimersByTime(1);
    expect(socket.getState()).toBe('closed');
  });
});
