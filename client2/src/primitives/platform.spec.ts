import { adapter } from '~/adapters.ts';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  incoming: { message: { text: string } };
}

/** A hand-driven adapter: flip visibility and network from the test. */
function mockAdapter() {
  let vis: ((v: boolean) => void) | null = null;
  let net: ((v: boolean) => void) | null = null;
  const visUnsub = vi.fn();
  const netUnsub = vi.fn();
  const instance = adapter({
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
    adapter: instance,
    visUnsub,
    netUnsub,
    setVisible: (v: boolean) => vis?.(v),
    setOnline: (v: boolean) => net?.(v),
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
function build(...primitives: any[]) {
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
  const socket = (client<C>() as any)(connect('wss://test'), ...primitives);
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
    const m = mockAdapter();
    const { socket } = build(platform({ adapter: m.adapter, backgroundDisconnectMs: 1000 }));

    m.setVisible(false);
    vi.advanceTimersByTime(999);
    expect(socket.getState()).toBe('open');

    vi.advanceTimersByTime(1);
    expect(socket.getState()).toBe('closed');

    m.setVisible(true);
    expect(socket.getState()).toBe('connecting');
    MockWebSocket.last().open();
    expect(socket.getState()).toBe('open');
  });

  it('resets the timer on each visibility change', () => {
    const m = mockAdapter();
    const { socket } = build(platform({ adapter: m.adapter, backgroundDisconnectMs: 1000 }));

    m.setVisible(false);
    vi.advanceTimersByTime(500);
    m.setVisible(true); // cancels
    m.setVisible(false); // restarts the countdown
    vi.advanceTimersByTime(999);
    expect(socket.getState()).toBe('open');
    vi.advanceTimersByTime(1);
    expect(socket.getState()).toBe('closed');
  });

  it('throws WSKitConfigError when backgroundDisconnectMs is set but the adapter has no onVisibilityChange', () => {
    const netOnly = adapter({ onNetworkChange: () => () => undefined });
    expect(() =>
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
      (client<C>() as any)(
        connect('wss://test'),
        platform({ adapter: netOnly, backgroundDisconnectMs: 1000 }),
      ),
    ).toThrow(/onVisibilityChange/);
  });

  it('keeps the lazy consumer count across a background disconnect/reconnect', () => {
    const m = mockAdapter();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
    const socket = (client<C>() as any)(
      connect('wss://test', { lazy: true, idleTimeout: 1000 }),
      platform({ adapter: m.adapter, backgroundDisconnectMs: 500 }),
    );
    // Two listeners → lazy connect; consumer count is 2.
    const un1 = socket.on('message', () => undefined);
    socket.on('message', () => undefined);
    MockWebSocket.last().open();
    expect(socket.getState()).toBe('open');

    // Hide → background disconnect after 500ms.
    m.setVisible(false);
    vi.advanceTimersByTime(500);
    expect(socket.getState()).toBe('closed');

    // Return → reconnect.
    m.setVisible(true);
    MockWebSocket.last().open();
    expect(socket.getState()).toBe('open');

    // Drop ONE listener — the other is still live, so it must NOT idle-close.
    un1();
    vi.advanceTimersByTime(1000);
    expect(socket.getState()).toBe('open');
  });

  it('detaches adapter listeners on a user disconnect()', () => {
    const m = mockAdapter();
    const { socket } = build(platform({ adapter: m.adapter, backgroundDisconnectMs: 1000 }));
    expect(m.visUnsub).not.toHaveBeenCalled();

    socket.disconnect();
    expect(m.visUnsub).toHaveBeenCalledTimes(1);
    expect(m.netUnsub).toHaveBeenCalledTimes(1);
  });
});

describe('network-aware reconnection (reconnection + platform online signal)', () => {
  it('pauses reconnect while offline, resumes immediately on online', () => {
    const m = mockAdapter();
    const { ws, socket } = build(platform({ adapter: m.adapter }), reconnection());

    ws.serverClose(1006);
    expect(socket.getState()).toBe('reconnecting');

    m.setOnline(false);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // no retry while offline
    expect(socket.getState()).toBe('reconnecting'); // still active, not closed

    m.setOnline(true);
    expect(MockWebSocket.instances).toHaveLength(2); // retried at once
  });

  it('does not schedule a retry when the drop happens while already offline', () => {
    const m = mockAdapter();
    const { ws } = build(platform({ adapter: m.adapter }), reconnection());

    m.setOnline(false);
    ws.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    m.setOnline(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('stays timer-only and never throws with no adapter signal', () => {
    const { ws, socket } = build(reconnection({ networkAware: true }));
    ws.serverClose(1006);
    expect(socket.getState()).toBe('reconnecting');
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('networkAware: false ignores the online signal even when present', () => {
    const m = mockAdapter();
    const { ws } = build(platform({ adapter: m.adapter }), reconnection({ networkAware: false }));

    m.setOnline(false); // ignored
    ws.serverClose(1006);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2); // retried despite being "offline"
  });
});
