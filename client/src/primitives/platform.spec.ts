import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApi } from '~/primitives/platform.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { message: { text: string } };
}

/** A hand-driven environment: flip visibility and network from the test. */
function mockEnvironment() {
  let vis: ((v: boolean) => void) | null = null;
  let net: ((v: boolean) => void) | null = null;
  const visUnsub = vi.fn();
  const netUnsub = vi.fn();
  const instance = environment({
    onVisibilityChange(cb) {
      vis = cb;
      return visUnsub;
    },
    onNetworkChange(cb) {
      net = cb;
      return netUnsub;
    },
  });

  return {
    environment: instance,
    visUnsub,
    netUnsub,
    setVisible: (v: boolean) => vis?.(v),
    setOnline: (v: boolean) => net?.(v),
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

describe('background disconnect', () => {
  it('disconnects after backgroundDisconnectMs when hidden, reconnects when visible', () => {
    const m = mockEnvironment();
    const { socket } = build(
      platform({ environment: m.environment, backgroundDisconnectMs: 1000 }),
    );

    m.setVisible(false);
    vi.advanceTimersByTime(999);
    expect(socket.state.get()).toBe('open');

    vi.advanceTimersByTime(1);
    expect(socket.state.get()).toBe('closed');

    m.setVisible(true);
    expect(socket.state.get()).toBe('connecting');
    MockWebSocket.last().open();
    expect(socket.state.get()).toBe('open');
  });

  it('resets the timer on each visibility change', () => {
    const m = mockEnvironment();
    const { socket } = build(
      platform({ environment: m.environment, backgroundDisconnectMs: 1000 }),
    );

    m.setVisible(false);
    vi.advanceTimersByTime(500);
    m.setVisible(true);
    m.setVisible(false);
    vi.advanceTimersByTime(999);

    expect(socket.state.get()).toBe('open');
    vi.advanceTimersByTime(1);
    expect(socket.state.get()).toBe('closed');
  });

  it('does not reconnect on foreground when the socket dropped on its own while hidden', () => {
    const m = mockEnvironment();
    const { socket, ws } = build(
      platform({ environment: m.environment, backgroundDisconnectMs: 1000 }),
    );

    m.setVisible(false);
    ws.serverClose(1006, 'network blip');
    expect(socket.state.get()).toBe('closed');

    vi.advanceTimersByTime(1000);

    m.setVisible(true); // returning must NOT trigger a platform reconnect
    expect(socket.state.get()).toBe('closed');
  });

  it('throws LiveThingConfigError when backgroundDisconnectMs is set but the environment has no onVisibilityChange', () => {
    const netOnly = environment({ onNetworkChange: () => () => undefined });
    expect(() =>
      client<C>()(
        connect('wss://test'),
        platform({ environment: netOnly, backgroundDisconnectMs: 1000 }),
      ),
    ).toThrow(/onVisibilityChange/);
  });

  it('keeps the lazy consumer count across a background disconnect/reconnect', () => {
    const m = mockEnvironment();
    const socket = client<C>()(
      connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }),
      platform({ environment: m.environment, backgroundDisconnectMs: 500 }),
    );
    const un1 = socket.on('message', () => undefined);
    socket.on('message', () => undefined);
    MockWebSocket.last().open();

    expect(socket.state.get()).toBe('open');

    m.setVisible(false);
    vi.advanceTimersByTime(500);
    expect(socket.state.get()).toBe('closed');

    m.setVisible(true);
    MockWebSocket.last().open();
    expect(socket.state.get()).toBe('open');

    // Drop ONE listener — the other is still live, so it must NOT idle-close.
    un1();
    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('open');
  });

  it('detaches environment listeners on a user disconnect()', () => {
    const m = mockEnvironment();
    const { socket } = build(
      platform({ environment: m.environment, backgroundDisconnectMs: 1000 }),
    );
    expect(m.visUnsub).not.toHaveBeenCalled();

    socket.disconnect();
    expect(m.visUnsub).toHaveBeenCalledTimes(1);
    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });
});

describe('manual connect while already hidden', () => {
  it('manual socket.connect() while hidden must not be auto-dropped by background timer', () => {
    let visCb: ((v: boolean) => void) | null = null;
    const visUnsub = vi.fn();
    const env = environment({
      onVisibilityChange(cb) {
        visCb = cb;
        cb(false);
        return visUnsub;
      },
    });

    const socket = client<C>()(
      connect('wss://test'),
      platform({ environment: env, backgroundDisconnectMs: 1000 }),
    );

    socket.connect();
    MockWebSocket.last().open();
    expect(socket.state.get()).toBe('open');

    // Advance past backgroundDisconnectMs. The socket was manually opened
    // while hidden; the platform primitive must NOT drop it.
    vi.advanceTimersByTime(1000);
    expect(socket.state.get()).toBe('open');

    void visCb;
  });
});

describe('network-aware reconnection (reconnection + platform online signal)', () => {
  it('pauses reconnect while offline, retries immediately on online', () => {
    const m = mockEnvironment();
    const { ws, socket } = build(platform({ environment: m.environment }), reconnection());

    ws.serverClose(1006);
    expect(socket.state.get()).toBe('reconnecting');

    m.setOnline(false);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.state.get()).toBe('reconnecting');

    m.setOnline(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not schedule a retry when the drop happens while already offline', () => {
    const m = mockEnvironment();
    const { ws } = build(platform({ environment: m.environment }), reconnection());

    m.setOnline(false);
    ws.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    m.setOnline(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('stays timer-only and never throws with no environment signal', () => {
    const { ws, socket } = build(reconnection({ networkAware: true }));
    ws.serverClose(1006);
    expect(socket.state.get()).toBe('reconnecting');
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('networkAware: false ignores the online signal even when present', () => {
    const m = mockEnvironment();
    const { ws } = build(
      platform({ environment: m.environment }),
      reconnection({ networkAware: false }),
    );

    m.setOnline(false);
    ws.serverClose(1006);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

describe('network signal before the first open', () => {
  function offlineAtStart() {
    const netUnsub = vi.fn();
    let net: ((v: boolean) => void) | null = null;
    const onNetworkChange = vi.fn((cb: (v: boolean) => void) => {
      net = cb;
      cb(false);
      return netUnsub;
    });
    return {
      environment: environment({ onNetworkChange }),
      onNetworkChange,
      netUnsub,
      setOnline: (v: boolean) => net?.(v),
    };
  }

  it('pauses retries when the device is offline before the first connection opens', () => {
    const m = offlineAtStart();
    const socket = client<C>()(
      connect('wss://test'),
      platform({ environment: m.environment }),
      reconnection(),
    );

    socket.connect();
    expect(socket.online.get()).toBe(false);

    MockWebSocket.last().serverClose(1006);
    expect(socket.state.get()).toBe('reconnecting');
    expect(socket.reconnection.get()).toEqual({ retrying: true, attempt: 0, nextRetryAt: null });

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    m.setOnline(true);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.last().open();
    expect(socket.state.get()).toBe('open');
  });

  it('binds the environment once across connect, retry and open', () => {
    const m = offlineAtStart();
    const socket = client<C>()(
      connect('wss://test'),
      platform({ environment: m.environment }),
      reconnection(),
    );

    socket.connect();
    MockWebSocket.last().serverClose(1006);
    m.setOnline(true);
    MockWebSocket.last().open();

    expect(m.onNetworkChange).toHaveBeenCalledTimes(1);
    expect(m.netUnsub).not.toHaveBeenCalled();
  });

  it('does not bind before connect() is called', () => {
    const m = offlineAtStart();
    const socket = client<C>()(connect('wss://test'), platform({ environment: m.environment }));

    expect(m.onNetworkChange).not.toHaveBeenCalled();
    expect(socket.online.get()).toBe(true);
  });

  it('unbinds on disconnect() and binds again on the next connect()', () => {
    const m = offlineAtStart();
    const socket = client<C>()(connect('wss://test'), platform({ environment: m.environment }));

    socket.connect();
    socket.disconnect();
    expect(m.netUnsub).toHaveBeenCalledTimes(1);

    socket.connect();
    expect(m.onNetworkChange).toHaveBeenCalledTimes(2);
    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });

  it('unbinds when disconnect() is called before the first open', () => {
    const m = offlineAtStart();
    const socket = client<C>()(connect('wss://test'), platform({ environment: m.environment }));

    socket.connect();
    socket.disconnect();

    expect(m.onNetworkChange).toHaveBeenCalledTimes(1);
    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });
});

function buildWithOnline(m: ReturnType<typeof mockEnvironment>) {
  const { socket, ws } = build(platform({ environment: m.environment }));
  return { socket: socket as typeof socket & PlatformApi, ws };
}

describe('socket.online store', () => {
  it('defaults to true before any network change', () => {
    const m = mockEnvironment();
    const { socket } = buildWithOnline(m);
    expect(socket.online.get()).toBe(true);
  });

  it('reflects the environment going offline and back online', () => {
    const m = mockEnvironment();
    const { socket } = buildWithOnline(m);

    m.setOnline(false);
    expect(socket.online.get()).toBe(false);

    m.setOnline(true);
    expect(socket.online.get()).toBe(true);
  });

  it('publishes each network change to subscribers', () => {
    const m = mockEnvironment();
    const { socket } = buildWithOnline(m);
    const states: boolean[] = [];
    socket.online.subscribe((online) => states.push(online));

    m.setOnline(false);
    m.setOnline(true);

    expect(states).toEqual([false, true]);
  });
});
