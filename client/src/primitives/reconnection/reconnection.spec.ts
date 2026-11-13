import { CloseCodes, LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconnectionApi } from '~/primitives/reconnection/reconnection.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { message: { text: string } };
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

describe('reconnection — option ranges', () => {
  it.each([NaN, -1, 1.5, '3'])('rejects maxAttempts %s, naming the option', (maxAttempts) => {
    expect(() => reconnection({ maxAttempts: maxAttempts as number })).toThrow(
      expect.objectContaining({
        constructor: LiveThingConfigError,
        message: expect.stringContaining('reconnection maxAttempts'),
      }),
    );
  });

  it.each([0, 1, 10, Infinity])('accepts maxAttempts %s', (maxAttempts) => {
    expect(() => reconnection({ maxAttempts })).not.toThrow();
  });

  it.each([NaN, 0, -1, Infinity, 2 ** 31, '100'])(
    'rejects maxDelay %s, naming the option',
    (maxDelay) => {
      expect(() => reconnection({ maxDelay: maxDelay as number })).toThrow(
        expect.objectContaining({
          constructor: LiveThingConfigError,
          message: expect.stringContaining('reconnection maxDelay'),
        }),
      );
    },
  );

  it.each([1, 30_000, 2 ** 31 - 1])('accepts maxDelay %s', (maxDelay) => {
    expect(() => reconnection({ maxDelay })).not.toThrow();
  });
});

function mockEnvironment() {
  let net: ((v: boolean) => void) | null = null;
  const netUnsub = vi.fn();
  const instance = environment({
    onNetworkChange(cb) {
      net = cb;
      return netUnsub;
    },
  });
  return {
    environment: instance,
    setOnline: (v: boolean) => net?.(v),
  };
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

describe('max attempts exhaustion', () => {
  it('fires reconnectFailed and moves to closed after maxAttempts retry sockets all fail', () => {
    const onFailed = vi.fn();
    const socket = client<C>()(connect('wss://test'), reconnection({ maxAttempts: 2 }));
    socket.connect();
    MockWebSocket.last().open();
    socket.onReconnectFailed(onFailed);

    // Each wait is past the backoff and short of the 30 s connect timeout.
    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(5_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(5_000);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.last().serverClose(1006);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(socket.state.get()).toBe('closed');
  });

  it('reaches maxAttempts=1 after a single failed retry', () => {
    const onFailed = vi.fn();
    const socket = client<C>()(connect('wss://test'), reconnection({ maxAttempts: 1 }));
    socket.connect();
    MockWebSocket.last().open();
    socket.onReconnectFailed(onFailed);

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last().serverClose(1006);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(socket.state.get()).toBe('closed');
  });
});

describe('backoff growth and jitter', () => {
  it('first retry delay is in the [700ms, 1300ms] jitter window (attempt=0 => base=1000ms)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = build(reconnection());

    ws.serverClose(1006);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('second retry delay doubles the base (attempt=1 => base=2000ms)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = build(reconnection());

    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('never schedules a wait longer than a timer can hold, even with jitter on the largest maxDelay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { socket } = build(reconnection({ maxDelay: 2 ** 31 - 1, maxAttempts: Infinity }));
    // Each long wait also runs out the connect timeout of the socket that is still connecting.
    socket.onError(() => {});

    for (let attempt = 0; attempt < 24; attempt++) {
      MockWebSocket.last().serverClose(1006);
      vi.advanceTimersByTime(2 ** 31 - 1);
    }

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] ?? 0);
    expect(Math.max(...delays)).toBe(2 ** 31 - 1);
  });

  it('caps delay at maxDelay regardless of attempt count', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = build(reconnection({ maxDelay: 500 }));

    ws.serverClose(1006);
    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('jitter at random=0 gives base*0.7 (lower bound)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { ws } = build(reconnection());

    ws.serverClose(1006);
    vi.advanceTimersByTime(699);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('jitter at random=1 gives base*1.3 (upper bound)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { ws } = build(reconnection());

    ws.serverClose(1006);
    vi.advanceTimersByTime(1299);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('a successful open resets the attempt counter so the next drop restarts at base=1000ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws } = build(reconnection());

    ws.serverClose(1006);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(2000);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.last().open();

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('disconnect() resets the attempt counter, so the next connect starts with no old backoff', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const built = build(reconnection());
    const socket = built.socket as typeof built.socket & ReconnectionApi;
    built.ws.serverClose(1006);
    vi.advanceTimersByTime(1000);

    MockWebSocket.last().serverClose(1006);

    expect(socket.reconnection.get().attempt).toBe(2);

    socket.disconnect();
    socket.connect();
    MockWebSocket.last().serverClose(1006);

    expect(socket.reconnection.get().attempt).toBe(1);
  });
});

describe('online signal resets attempt counter', () => {
  it('going offline then back online resets attempt to 0 so delay restarts at 1000ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const m = mockEnvironment();
    const { ws } = build(platform({ environment: m.environment }), reconnection());

    ws.serverClose(1006);
    expect(socket_instanceCount()).toBe(1);

    m.setOnline(false);
    vi.advanceTimersByTime(60_000);
    expect(socket_instanceCount()).toBe(1);

    m.setOnline(true);
    expect(socket_instanceCount()).toBe(2);

    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(999);
    expect(socket_instanceCount()).toBe(2);
    vi.advanceTimersByTime(1);

    expect(socket_instanceCount()).toBe(3);
  });

  it('going back online while reconnecting issues a reopen without waiting for the timer', () => {
    const m = mockEnvironment();
    const { ws } = build(platform({ environment: m.environment }), reconnection());

    m.setOnline(false);
    ws.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(socket_instanceCount()).toBe(1);

    m.setOnline(true);
    expect(socket_instanceCount()).toBe(2);
  });
});

describe('shouldReconnect precedence', () => {
  it('options.shouldReconnect returning false suppresses retry for an otherwise retryable code', () => {
    const { ws, socket } = build(
      reconnection({ shouldReconnect: (code) => (code === 4000 ? false : undefined) }),
    );
    ws.serverClose(4000);
    expect(socket.state.get()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('options.shouldReconnect returning true overrides a nonRetryable code', () => {
    const { ws, socket } = build(
      reconnection({
        nonRetryableCodes: [4001],
        shouldReconnect: (code) => (code === 4001 ? true : undefined),
      }),
    );
    ws.serverClose(4001);
    expect(socket.state.get()).toBe('reconnecting');
  });

  it('options.shouldReconnect returning undefined falls through to nonRetryableCodes', () => {
    const { ws, socket } = build(
      reconnection({
        nonRetryableCodes: [4002],
        shouldReconnect: () => undefined,
      }),
    );
    ws.serverClose(4002);
    expect(socket.state.get()).toBe('closed');
  });
});

describe('default non-retryable close codes', () => {
  it.each([
    ['AUTH_INVALID', CloseCodes.AUTH_INVALID],
    ['DUPLICATE', CloseCodes.DUPLICATE],
    ['BANNED', CloseCodes.BANNED],
  ])('does not reconnect after %s with no options', (_name, code) => {
    const { ws, socket } = build(reconnection());
    ws.serverClose(code);
    vi.advanceTimersByTime(60_000);
    expect(socket.state.get()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('adds nonRetryableCodes to the defaults instead of replacing them', () => {
    const { ws, socket } = build(reconnection({ nonRetryableCodes: [4100] }));
    ws.serverClose(CloseCodes.BANNED);
    vi.advanceTimersByTime(60_000);
    expect(socket.state.get()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('lets shouldReconnect returning true retry a default non-retryable code', () => {
    const { ws, socket } = build(
      reconnection({
        shouldReconnect: (code) => (code === CloseCodes.DUPLICATE ? true : undefined),
      }),
    );
    ws.serverClose(CloseCodes.DUPLICATE);
    expect(socket.state.get()).toBe('reconnecting');
  });

  it('stops after one replaced connection when every reopen is closed with DUPLICATE', () => {
    const { ws } = build(reconnection({ maxAttempts: 3 }));
    ws.serverClose(CloseCodes.DUPLICATE);
    for (let round = 0; round < 50; round++) {
      vi.advanceTimersByTime(60_000);
      const latest = MockWebSocket.last();
      if (latest.readyState === 0) {
        latest.open();
        latest.serverClose(CloseCodes.DUPLICATE);
      }
    }

    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('reconnect policy error isolation', () => {
  it('reports a throwing user shouldReconnect and still reconnects by default', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const errors: unknown[] = [];
    const socket = client<C>()(
      connect('wss://test'),
      reconnection({
        shouldReconnect: () => {
          throw new Error('policy boom');
        },
      }),
    );
    socket.onError((error) => errors.push(error));
    socket.connect();

    MockWebSocket.last().open();

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(1000);

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(errors).toHaveLength(1);
  });
});

function buildWithReconnection(...args: Parameters<typeof reconnection>) {
  const { socket, ws } = build(reconnection(...args));
  return { socket: socket as typeof socket & ReconnectionApi, ws };
}

describe('socket.reconnection store', () => {
  it('starts idle with no attempts and no scheduled retry', () => {
    const { socket } = buildWithReconnection();
    expect(socket.reconnection.get()).toEqual({
      retrying: false,
      attempt: 0,
      nextRetryAt: null,
    });
  });

  it('reports retrying with a counted attempt and a future nextRetryAt after a drop', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws, socket } = buildWithReconnection();

    ws.serverClose(1006);

    const info = socket.reconnection.get();
    expect(info.retrying).toBe(true);
    expect(info.attempt).toBe(1);
    expect(info.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('publishes the snapshot to subscribers as the loop advances', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws, socket } = buildWithReconnection();
    const snapshots: Array<{ retrying: boolean; attempt: number }> = [];
    socket.reconnection.subscribe((info) =>
      snapshots.push({ retrying: info.retrying, attempt: info.attempt }),
    );

    ws.serverClose(1006);

    expect(snapshots.at(-1)).toEqual({ retrying: true, attempt: 1 });
  });

  it('resets to idle once a retry connection opens', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws, socket } = buildWithReconnection();

    ws.serverClose(1006);
    expect(socket.reconnection.get().retrying).toBe(true);

    vi.advanceTimersByTime(5_000);
    MockWebSocket.last().open();

    expect(socket.reconnection.get()).toEqual({
      retrying: false,
      attempt: 0,
      nextRetryAt: null,
    });
  });

  it('clears nextRetryAt when the device goes offline while a retry is pending', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const m = mockEnvironment();
    const { ws, socket } = build(platform({ environment: m.environment }), reconnection());
    const typed = socket as typeof socket & ReconnectionApi;

    ws.serverClose(1006);
    expect(typed.reconnection.get().nextRetryAt).not.toBeNull();

    m.setOnline(false);

    expect(typed.reconnection.get()).toEqual({ retrying: true, attempt: 1, nextRetryAt: null });
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(typed.reconnection.get().nextRetryAt).toBeNull();
  });

  it('stays idle when the device goes offline while the socket is open', () => {
    const m = mockEnvironment();
    const { socket } = build(platform({ environment: m.environment }), reconnection());
    const typed = socket as typeof socket & ReconnectionApi;

    m.setOnline(false);

    expect(typed.reconnection.get()).toEqual({ retrying: false, attempt: 0, nextRetryAt: null });
  });

  it('stops retrying once the loop gives up after maxAttempts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ws, socket } = buildWithReconnection({ maxAttempts: 2 });

    ws.serverClose(1006);
    vi.advanceTimersByTime(5_000);
    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(5_000);
    MockWebSocket.last().serverClose(1006);

    vi.advanceTimersByTime(5_000);

    const info = socket.reconnection.get();
    expect(info.retrying).toBe(false);
    expect(info.nextRetryAt).toBeNull();
  });
});

function socket_instanceCount() {
  return MockWebSocket.instances.length;
}
