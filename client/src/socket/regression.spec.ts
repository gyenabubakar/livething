// Kernel connection guarantees: throwing-listener isolation, idempotent
// unsubscribe, close-state ordering, session reset on disconnect, and
// stale-socket inertness.
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { ack } from '~/primitives/ack/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { requestResponse } from '~/primitives/request-response/index.ts';
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

interface AckContract {
  outgoing: { x: { v: number } };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  descriptor: ConnectDescriptor,
  ...primitives: [...P] & ValidatePrimitives<LooseContract, P>
): Socket<LooseContract> & ApplyPrimitives<P, LooseContract> {
  // The generic wrapper can't carry each primitive's added API through inference,
  // so we assert it; ApplyPrimitives<P, …> still resolves at each call site.
  const socket = client<LooseContract>()(
    descriptor,
    ...primitives,
  ) as unknown as Socket<LooseContract> & ApplyPrimitives<P, LooseContract>;
  // A couple of tests here deliberately throw inside a close listener; sink the
  // error so the no-listener out-of-band rethrow doesn't fail the suite.
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
    expect(socket.getState()).toBe('reconnecting');
  });
});

describe('idempotent on() unsubscribe', () => {
  it('a live listener keeps the socket open even after a sibling is unsubbed twice', () => {
    vi.useFakeTimers();
    try {
      const socket = build(connect('wss://test', { lazy: true, idleTimeout: 1000 }));
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
    const socket = build(connect('wss://test'));
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
    const socket = build(connect('wss://test'), reconnection());
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
    socket.connect(); // ws1 created, state "connecting", this.ws still null
    const ws1 = MockWebSocket.last();
    socket.disconnect(); // bumps attemptId; ws1 handlers are NOT nulled (this.ws was null)
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

describe('disconnect() is a quiet no-op when already closed', () => {
  it('does not fire onClose a second time on a redundant disconnect', () => {
    const socket = build(connect('wss://test'));
    socket.connect();
    MockWebSocket.last().open();
    const onClose = vi.fn();
    socket.onClose(onClose);
    socket.disconnect();
    socket.disconnect(); // redundant
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
    socket.connect(); // connecting, this.ws still null
    socket.disconnect();
    expect(onClose).toHaveBeenCalledTimes(1); // matches native close-during-connecting
  });

  it('a deliberate disconnect after a terminal drop still resets the session', () => {
    const onReconnect = vi.fn();
    const socket = build(connect('wss://test')); // no reconnection → a drop is terminal
    socket.onReconnect(onReconnect);
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006); // terminal drop → closed, but _isFirstConnect still false
    socket.disconnect(); // already closed, yet must still reset the session
    socket.connect();
    MockWebSocket.last().open();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});

describe('disconnect() still cleans up primitives when already closed', () => {
  it('clears the buffer even if the socket is already closed', () => {
    const socket = build(connect('wss://test'), buffering({ enabled: true }));
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006); // drop → closed, buffer kept (no reconnection)
    expect(socket.getState()).toBe('closed');

    socket.send('y', { v: 1 }); // buffered while closed
    socket.disconnect(); // must discard the buffer
    socket.connect();
    MockWebSocket.last().open(); // onOpen flush must NOT replay 'y'

    expect(
      MockWebSocket.last()
        .sentFrames()
        .some((f) => f.event === 'y'),
    ).toBe(false);
  });

  it('rejects a pending sendWithAck even if the socket is already closed', async () => {
    const socket = client<AckContract>()(connect('wss://test'), ack({ timeout: 100 }));
    const pending = socket.sendWithAck('x', { v: 1 }); // pending created while closed
    socket.disconnect(); // must reject it with Disconnected, not let it time out
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  });
});

describe('lazy idle-close after a zero-consumer reconnect', () => {
  it('idle-closes when a reconnect completes with no consumers left', () => {
    vi.useFakeTimers();
    try {
      const socket = build(
        connect('wss://test', { lazy: true, idleTimeout: 1000 }),
        reconnection(),
      );
      const unsub = socket.on('x', () => {}); // lazy connect
      MockWebSocket.last().open();
      MockWebSocket.last().serverClose(1006); // → reconnecting
      unsub(); // last consumer releases mid-reconnect → count 0, no timer armed
      vi.advanceTimersByTime(2000); // reconnection retry fires → a fresh socket
      MockWebSocket.last().open(); // reconnect opens with 0 consumers
      expect(socket.getState()).toBe('open');
      vi.advanceTimersByTime(1000); // idle timeout should now elapse
      expect(socket.getState()).toBe('closed');
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
      vi.advanceTimersByTime(1000); // sends a ping
      ws.emit('pong'); // raw pong measures latency
      expect(socket.getLatency()).not.toBeNull();
      socket.disconnect();
      expect(socket.getLatency()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

interface RequestContract {
  requests: { ping: { payload: null; response: null } };
}

describe('idle timer armed during close must not fire during reconnect', () => {
  it('socket stays reconnecting when idle timeout elapses while a reconnect is in progress', async () => {
    vi.useFakeTimers();
    try {
      const socket = client<RequestContract>()(
        connect('wss://test', { lazy: true, idleTimeout: 1000 }),
        reconnection(),
        requestResponse({ timeout: 60_000 }),
      );

      // Make a request — this is the only lazy consumer (_lazyConsumers = 1).
      // The promise will reject when the socket drops, releasing the lazy hold.
      const pending = socket.request('ping', null);

      // The lazy connect triggered by request() opens the socket.
      MockWebSocket.last().open();

      // Drop the connection. Inside ws.onclose the primitives' onClose fires
      // while state is still 'open': requestResponse.onClose rejects the
      // pending request (done() → lazyRelease()), which sees _state === 'open'
      // and _lazyConsumers === 0, so it arms the idle timer. Reconnection then
      // sets the state to 'reconnecting'. The idle timer is never cleared.
      MockWebSocket.last().serverClose(1006);

      // Consume the rejection so the unhandled-rejection detector stays quiet.
      await pending.catch(() => {});

      // At this point we should be reconnecting.
      expect(socket.getState()).toBe('reconnecting');

      // Advance past the idle timeout while the reconnect timer is still pending.
      // Bug: the un-cleared idle timer fires disconnect(), setting state 'closed'.
      // Correct behavior: state is 'reconnecting' (or 'open' if the retry fired).
      vi.advanceTimersByTime(1500);

      expect(socket.getState()).not.toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });
});
