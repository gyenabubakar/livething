import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { environment } from '~/environment.ts';
import { platform } from '~/primitives/platform.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.last().serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.last().serverClose(1006);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(socket.getState()).toBe('closed');
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
    expect(socket.getState()).toBe('closed');
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
    expect(socket.getState()).toBe('closed');
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
    expect(socket.getState()).toBe('reconnecting');
  });

  it('options.shouldReconnect returning undefined falls through to nonRetryableCodes', () => {
    const { ws, socket } = build(
      reconnection({
        nonRetryableCodes: [4002],
        shouldReconnect: () => undefined,
      }),
    );
    ws.serverClose(4002);
    expect(socket.getState()).toBe('closed');
  });

  it('primitive shouldReconnect hook returning false takes precedence over options.shouldReconnect', () => {
    const vetoer = {
      _tag: 'vetoer',
      setup: () => ({
        id: 'vetoer',
        shouldReconnect: (_code: number, _reason: string): boolean | void => false,
      }),
    };
    const { ws, socket } = build(reconnection({ shouldReconnect: () => true }), vetoer);
    ws.serverClose(1006);
    expect(socket.getState()).toBe('closed');
  });

  it('primitive shouldReconnect hook returning true takes precedence over nonRetryableCodes', () => {
    const approver = {
      _tag: 'approver',
      setup: () => ({
        id: 'approver',
        shouldReconnect: (_code: number, _reason: string): boolean | void => true,
      }),
    };
    const { ws, socket } = build(reconnection({ nonRetryableCodes: [4003] }), approver);
    ws.serverClose(4003);
    expect(socket.getState()).toBe('reconnecting');
  });
});

describe('reconnect policy error isolation (#18)', () => {
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

function socket_instanceCount() {
  return MockWebSocket.instances.length;
}
