// Kernel connection guarantees: throwing-listener isolation, idempotent
// unsubscribe, close-state ordering, session reset on disconnect, and
// stale-socket inertness.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectDescriptor } from '~/connect.ts';
import type { ApplyPrimitives, Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { Socket } from '~/socket/api.ts';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

interface LooseContract {
  incoming: Record<string, unknown>;
  outgoing: Record<string, unknown>;
}

interface CloseRequestContract {
  clientRequests: { x: { payload: { v: number }; response: { ok: boolean } } };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  descriptor: ConnectDescriptor,
  ...primitives: [...P] & ValidatePrimitives<LooseContract, P>
): Socket<LooseContract> & ApplyPrimitives<P, LooseContract> {
  const socket = client<LooseContract>()(
    descriptor,
    ...primitives,
  ) as unknown as Socket<LooseContract> & ApplyPrimitives<P, LooseContract>;
  socket.onError(() => {});
  return socket;
}

describe('throwing onClose listener', () => {
  it('still schedules reconnection and does not throw out of the close handler', () => {
    const socket = build(connect('wss://test'), reconnection());
    socket.connect();
    MockWebSocket.last().open();
    socket.onClose(() => {
      throw new Error('boom');
    });
    const ws = MockWebSocket.last();

    expect(() => ws.serverClose(1006)).not.toThrow();
    expect(socket.state.get()).toBe('reconnecting');
  });
});

describe('idempotent on() unsubscribe', () => {
  it('a live listener keeps the socket open even after a sibling is unsubbed twice', () => {
    vi.useFakeTimers();
    try {
      const socket = build(connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }));
      const unsubA = socket.on('a', () => {});
      socket.on('b', () => {});
      MockWebSocket.last().open();
      unsubA();

      unsubA();
      vi.advanceTimersByTime(1000);
      expect(socket.state.get()).toBe('open'); // B is still live → must NOT idle-close
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('state is settled before onClose fires', () => {
  it('reads "closed" inside onClose on a terminal drop (no reconnection)', () => {
    const socket = build(connect('wss://test'));
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    let inside = '';

    socket.onClose(() => {
      inside = socket.state.get();
    });
    ws.serverClose(1006);
    expect(inside).toBe('closed');
  });

  it('reads "reconnecting" inside onClose when reconnection is installed', () => {
    const socket = build(connect('wss://test'), reconnection());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    let inside = '';

    socket.onClose(() => {
      inside = socket.state.get();
    });
    ws.serverClose(1006);
    expect(inside).toBe('reconnecting');
  });
});

describe('disconnect() resets the session', () => {
  it('does not fire onReconnect on the post-disconnect open', () => {
    const onReconnect = vi.fn();
    const socket = build(connect('wss://test'));
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
    const socket = build(connect('wss://test'));
    const handler = vi.fn();
    socket.on('message', handler);
    socket.connect();
    const ws1 = MockWebSocket.last();

    socket.disconnect();
    ws1.emit({ event: 'message', payload: { text: 'late' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores an error from a socket abandoned during the connecting phase', () => {
    const socket = build(connect('wss://test'));
    const onErr = vi.fn();
    socket.onError(onErr);
    socket.connect();
    const ws1 = MockWebSocket.last();

    socket.disconnect();
    ws1.onerror?.({});
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe('manual connect() during reconnecting', () => {
  it('does not let the pending retry open a duplicate connection', () => {
    vi.useFakeTimers();
    try {
      const socket = build(connect('wss://test'), reconnection());
      socket.connect();
      MockWebSocket.last().open();
      MockWebSocket.last().serverClose(1006);
      expect(socket.state.get()).toBe('reconnecting');

      const before = MockWebSocket.instances.length;
      socket.connect();
      expect(MockWebSocket.instances.length).toBe(before + 1);

      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('disconnect() is a quiet no-op when already closed', () => {
  it('does not fire onClose a second time on a redundant disconnect', () => {
    const socket = build(connect('wss://test'));
    socket.connect();
    MockWebSocket.last().open();
    const onClose = vi.fn();
    socket.onClose(onClose);

    socket.disconnect();
    socket.disconnect();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClose when disconnecting a socket that never connected', () => {
    const socket = build(connect('wss://test'));
    const onClose = vi.fn();
    socket.onClose(onClose);
    socket.disconnect();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still fires onClose when closing a socket that is mid-connect (never opened)', () => {
    const socket = build(connect('wss://test'));
    const onClose = vi.fn();
    socket.onClose(onClose);
    socket.connect();
    socket.disconnect();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a deliberate disconnect after a terminal drop still resets the session', () => {
    const onReconnect = vi.fn();
    const socket = build(connect('wss://test'));
    socket.onReconnect(onReconnect);
    socket.connect();
    MockWebSocket.last().open();

    MockWebSocket.last().serverClose(1006);
    socket.disconnect();
    socket.connect();
    MockWebSocket.last().open();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});

describe('disconnect() still cleans up primitives when already closed', () => {
  it('clears the buffer even if the socket is already closed', () => {
    const socket = build(connect('wss://test'), buffering());
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);
    expect(socket.state.get()).toBe('closed');

    socket.send('y', { v: 1 });
    socket.disconnect();
    socket.connect();
    MockWebSocket.last().open(); // onOpen flush must NOT replay 'y'

    expect(
      MockWebSocket.last()
        .sentFrames()
        .some((f) => f.event === 'y'),
    ).toBe(false);
  });

  it('rejects a pending request even if the socket is already closed', async () => {
    const socket = client<CloseRequestContract>()(
      connect('wss://test'),
      clientRequests({ timeout: 100 }),
    );
    const pending = socket.request('x', { v: 1 });
    socket.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('lazy idle-close after a zero-consumer reconnect', () => {
  it('idle-closes when a reconnect completes with no consumers left', () => {
    vi.useFakeTimers();
    try {
      const socket = build(
        connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }),
        reconnection(),
      );
      const unsub = socket.on('x', () => {});
      MockWebSocket.last().open();
      MockWebSocket.last().serverClose(1006);
      unsub();

      vi.advanceTimersByTime(2000);
      MockWebSocket.last().open();
      expect(socket.state.get()).toBe('open');
      vi.advanceTimersByTime(1000);
      expect(socket.state.get()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getLatency() after disconnect', () => {
  it('returns null after a deliberate disconnect', () => {
    vi.useFakeTimers();
    try {
      const socket = build(connect('wss://test'), keepalive({ interval: 1000 }));
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();
      vi.advanceTimersByTime(1000);

      ws.emit('pong');
      expect(socket.latency.get()).not.toBeNull();
      socket.disconnect();
      expect(socket.latency.get()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

interface RequestContract {
  clientRequests: { echo: { payload: null; response: null } };
}

describe('idle timer armed during close must not fire during reconnect', () => {
  it('socket stays reconnecting when idle timeout elapses while a reconnect is in progress', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<RequestContract>()(
        connect('wss://test', { lazy: true, lazyIdleTimeoutMs: 1000 }),
        reconnection(),
        clientRequests({ timeout: 60_000 }),
      );

      const pending = socket.request('echo', null);

      MockWebSocket.last().open();

      // Drop the connection. Inside ws.onclose the primitives' onClose fires
      // while state is still 'open': clientRequests.onClose rejects the
      // pending request (done() → lazyRelease()), which sees _state === 'open'
      // and _lazyConsumers === 0, so it arms the idle timer. Reconnection then
      // sets the state to 'reconnecting'. The idle timer is never cleared.
      MockWebSocket.last().serverClose(1006);

      await pending.catch(() => {});

      expect(socket.state.get()).toBe('reconnecting');

      // Advance past the idle timeout while the reconnect timer is still pending.
      // The idle timer must be cleared: state stays 'reconnecting' (or 'open' if the retry fired).
      vi.advanceTimersByTime(1500);

      expect(socket.state.get()).not.toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});
