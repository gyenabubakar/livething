import { Block, LiveThingError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { intercept } from '~/primitives/intercept.ts';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { MockInstance } from 'vitest';

interface TestContract {
  incoming: { message: { text: string }; ad: { id: string } };
  outgoing: { 'mark-read': { notificationId: string }; typing: { channelId: string } };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

/** Build a connected socket with the given primitives. */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<TestContract, P>
) {
  const socket = client<TestContract>()(connect('wss://test'), ...primitives);
  socket.onError(() => {});
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

describe('intercept', () => {
  it('drops a message when Block is thrown', () => {
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept((m) => {
        if (m.event === 'ad') throw Block;
      }),
    );
    socket.on('ad', handler);
    socket.on('message', handler);
    ws.emit({ event: 'ad', payload: { id: '1' } });

    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('transforms a message when a new one is returned', () => {
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept((m) => ({ ...m, payload: { text: `${(m.payload as { text: string }).text}!` } })),
    );
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(handler).toHaveBeenCalledWith({ text: 'hi!' });
  });

  it('runs multiple intercepts in declaration order', () => {
    const order: number[] = [];
    const { socket, ws } = build(
      intercept(() => {
        order.push(1);
      }),
      intercept(() => {
        order.push(2);
      }),
    );
    socket.on('message', () => {});
    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(order).toEqual([1, 2]);
  });
});

describe('error routing', () => {
  it('fires onServerError with a LiveThingError for an unclaimed __error__ frame', () => {
    const onErr = vi.fn();
    const { socket, ws } = build();
    socket.onServerError(onErr);
    ws.emit({ event: '__error__', payload: { code: 'forbidden', detail: { reason: 'no' } } });
    expect(onErr).toHaveBeenCalledTimes(1);

    const err = onErr.mock.calls[0]![0] as LiveThingError;
    expect(err).toBeInstanceOf(LiveThingError);
    expect(err.code).toBe('forbidden');
    expect(err.detail).toEqual({ reason: 'no' });
  });

  it('does not dispatch __error__ to on() handlers', () => {
    const handler = vi.fn();
    const { socket, ws } = build();
    socket.on('message', handler);
    socket.onServerError(() => {});
    ws.emit({ event: '__error__', payload: { code: 'oops' } });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('buffering', () => {
  it('queues sends while disconnected and flushes on reconnect', () => {
    const socket = client<TestContract>()(connect('wss://test'), buffering());
    expect(socket.send('typing', { channelId: 'a' })).toBe(true);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect(ws.sentFrames()).toContainEqual({
      event: 'typing',
      payload: { channelId: 'a' },
      metadata: null,
    });
  });
});

describe('debug log redacts the connection URL', () => {
  function connectLogLines(spy: MockInstance<typeof console.log>): string[] {
    return spy.mock.calls
      .map((args) => args.join(' '))
      .filter((line) => line.includes('connecting to'));
  }

  it('drops a token from the connect log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const socket = client<TestContract>()(
      connect(async () => 'wss://test/huddle?token=SECRET-TOKEN-123'),
    );

    socket.setDebug(true);
    socket.connect();
    await Promise.resolve();
    const lines = connectLogLines(log);
    log.mockRestore();

    expect(MockWebSocket.last().url).toContain('token=SECRET-TOKEN-123');
    expect(lines).toEqual(['[livething] connecting to wss://test/huddle']);
  });

  it('drops userinfo and the hash from the connect log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const socket = client<TestContract>()(
      connect('wss://huddle-bot:hunter2@test/huddle?token=abc#frag'),
    );
    socket.setDebug(true);
    socket.connect();
    const lines = connectLogLines(log);

    log.mockRestore();

    expect(lines).toEqual(['[livething] connecting to wss://test/huddle']);
  });

  it('drops the query string from a relative URL', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const socket = client<TestContract>()(connect('/huddle?token=abc'));
    socket.setDebug(true);
    socket.connect();
    const lines = connectLogLines(log);

    log.mockRestore();

    expect(lines).toEqual(['[livething] connecting to /huddle']);
  });
});

describe('reconnection config', () => {
  it('suppresses reconnection for a non-retryable close code', () => {
    const socket = client<TestContract>()(
      connect('wss://test'),
      reconnection({ nonRetryableCodes: [4009] }),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    ws.serverClose(4009, 'banned');

    expect(socket.state.get()).toBe('closed');
  });

  it('reconnects on an ordinary drop when registered', () => {
    const socket = client<TestContract>()(connect('wss://test'), reconnection());
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006, 'dropped');
    expect(socket.state.get()).toBe('reconnecting');
  });

  it('does NOT reconnect when the primitive is absent (opt-in)', () => {
    const socket = client<TestContract>()(connect('wss://test'));
    socket.connect();
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006, 'dropped');
    expect(socket.state.get()).toBe('closed');
  });
});

describe('keepalive (opt-in)', () => {
  it('sends pings on its interval and measures pong latency', () => {
    vi.useFakeTimers();
    try {
      const socket = client<TestContract>()(connect('wss://test'), keepalive());
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open('', { pingIntervalMs: 1000 });
      vi.advanceTimersByTime(1000);

      expect(ws.sent).toContain('ping');
      ws.emit('pong');
      expect(socket.latency.get()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send pings without the primitive', () => {
    vi.useFakeTimers();
    try {
      const socket = client<TestContract>()(connect('wss://test'));
      socket.connect();
      const ws = MockWebSocket.last();
      ws.open();
      vi.advanceTimersByTime(60_000);

      expect(ws.sentFrames().some((f) => f.event === 'ping')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a binary frame', () => {
  it('is reported on onError and never reaches a handler', () => {
    const handler = vi.fn();
    const socket = client<TestContract>()(connect('wss://test'));
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    socket.on('message', handler);
    const onError = vi.fn();
    socket.onError(onError);
    expect(() => ws.emitRaw(new ArrayBuffer(4))).not.toThrow();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('kernel lifecycle-hook isolation', () => {
  function pair(hook: 'onOpen' | 'onReconnect' | 'onClose'): {
    ran: () => boolean;
    specs: Primitive[];
  } {
    let siblingRan = false;
    const thrower = {
      _tag: `thrower-${hook}`,
      setup: () => ({
        id: `thrower-${hook}`,
        [hook]: () => {
          throw new Error('boom');
        },
      }),
    };

    const sibling = {
      _tag: `sibling-${hook}`,
      setup: () => ({
        id: `sibling-${hook}`,
        [hook]: () => {
          siblingRan = true;
          return null;
        },
      }),
    };

    return { ran: () => siblingRan, specs: [thrower, sibling] };
  }

  it('contains a throwing onOpen so the rest of the open sequence still runs', () => {
    const p = pair('onOpen');
    const { socket } = build(...p.specs);
    expect(socket.state.get()).toBe('open');
    expect(p.ran()).toBe(true);
  });

  it('contains a throwing onClose on an unexpected drop', () => {
    const p = pair('onClose');
    const { ws } = build(...p.specs);
    expect(() => ws.serverClose(1006)).not.toThrow();
    expect(p.ran()).toBe(true);
  });

  it('contains a throwing onClose on disconnect()', () => {
    const p = pair('onClose');
    const { socket } = build(...p.specs);
    expect(() => socket.disconnect()).not.toThrow();
    expect(socket.state.get()).toBe('closed');
    expect(p.ran()).toBe(true);
  });

  it('contains a throwing onReconnect on a reconnect open', () => {
    vi.useFakeTimers();
    const p = pair('onReconnect');
    const { ws } = build(...p.specs, reconnection());
    ws.serverClose(1006);
    vi.advanceTimersByTime(2000);

    MockWebSocket.last().open();
    expect(p.ran()).toBe(true);
    vi.useRealTimers();
  });
});
