// Kernel regression tests from the phase 1-2 audit: throwing-listener isolation,
// idempotent unsubscribe, close-state ordering, session reset on disconnect, and
// stale-socket guards. Each one guards a fixed bug.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- loose for brevity
const c = client<any>() as any;

describe('throwing onClose listener', () => {
  it('still schedules reconnection and does not throw out of the close handler', () => {
    const socket = c(connect('wss://test'), reconnection());
    socket.connect();
    MockWebSocket.last().open();
    socket.onClose(() => {
      throw new Error('boom');
    });
    const ws = MockWebSocket.last();
    expect(() => ws.serverClose(1006)).not.toThrow();
    expect(socket.getState()).toBe('reconnecting');
  });
});

describe('idempotent on() unsubscribe', () => {
  it('a live listener keeps the socket open even after a sibling is unsubbed twice', () => {
    vi.useFakeTimers();
    try {
      const socket = c(connect('wss://test', { lazy: true, idleTimeout: 1000 }));
      const unsubA = socket.on('a', () => {});
      socket.on('b', () => {}); // two consumers
      MockWebSocket.last().open();
      unsubA();
      unsubA(); // second call must be a no-op
      vi.advanceTimersByTime(1000);
      expect(socket.getState()).toBe('open'); // B is still live → must NOT idle-close
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('state is settled before onClose fires', () => {
  it('reads "closed" inside onClose on a terminal drop (no reconnection)', () => {
    const socket = c(connect('wss://test'));
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    let inside = '';
    socket.onClose(() => {
      inside = socket.getState();
    });
    ws.serverClose(1006);
    expect(inside).toBe('closed');
  });

  it('reads "reconnecting" inside onClose when reconnection is installed', () => {
    const socket = c(connect('wss://test'), reconnection());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    let inside = '';
    socket.onClose(() => {
      inside = socket.getState();
    });
    ws.serverClose(1006);
    expect(inside).toBe('reconnecting');
  });
});

describe('disconnect() resets the session', () => {
  it('does not fire onReconnect on the post-disconnect open', () => {
    const onReconnect = vi.fn();
    const socket = c(connect('wss://test'));
    socket.onReconnect(onReconnect);
    socket.connect();
    MockWebSocket.last().open();
    socket.disconnect();
    socket.connect();
    MockWebSocket.last().open();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});

describe('superseded socket is inert', () => {
  it('ignores a message from a socket abandoned during the connecting phase', () => {
    const socket = c(connect('wss://test'));
    const handler = vi.fn();
    socket.on('message', handler);
    socket.connect(); // ws1 created, state "connecting", this.ws still null
    const ws1 = MockWebSocket.last();
    socket.disconnect(); // bumps attemptId; ws1 handlers are NOT nulled (this.ws was null)
    ws1.emit({ event: 'message', payload: { text: 'late' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an error from a socket abandoned during the connecting phase', () => {
    const socket = c(connect('wss://test'));
    const onErr = vi.fn();
    socket.onError(onErr);
    socket.connect();
    const ws1 = MockWebSocket.last();
    socket.disconnect();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- fire the raw handler
    (ws1 as any).onerror?.({});
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe('manual connect() during reconnecting', () => {
  it('does not let the pending retry open a duplicate connection', () => {
    vi.useFakeTimers();
    try {
      const socket = c(connect('wss://test'), reconnection());
      socket.connect();
      MockWebSocket.last().open();
      MockWebSocket.last().serverClose(1006); // → reconnecting, a retry is scheduled
      expect(socket.getState()).toBe('reconnecting');

      const before = MockWebSocket.instances.length;
      socket.connect(); // manual connect during the wait → one new socket
      expect(MockWebSocket.instances.length).toBe(before + 1);

      vi.advanceTimersByTime(60_000); // let the now-stale retry timer fire
      expect(MockWebSocket.instances.length).toBe(before + 1); // no duplicate
    } finally {
      vi.useRealTimers();
    }
  });
});
