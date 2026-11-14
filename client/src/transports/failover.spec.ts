import { CloseCodes } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { reconnection } from '~/primitives/reconnection/reconnection.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { websocket } from '~/transports/websocket.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport, TransportFactory, TransportOpenOptions } from '~/transports/transport.ts';
import type { SocketContract } from '~/types.ts';

/** A fake `sse()` the test drives by hand, like `MockWebSocket`. */
class FakeSse {
  static opened: FakeSse[] = [];

  closed = false;

  constructor(readonly options: TransportOpenOptions) {
    FakeSse.opened.push(this);
  }

  static last(): FakeSse {
    const last = FakeSse.opened.at(-1);
    if (!last) throw new Error('no FakeSse opened yet');

    return last;
  }

  /** The stream opened and the `__connected__` frame arrived. */
  connected(): void {
    this.options.events.open();
    this.options.events.message(
      JSON.stringify([
        '__connected__',
        {
          pingIntervalMs: null,
          idleTimeoutMs: null,
          maxResumeTokens: 8,
          connectionId: 'c_sse',
          features: [],
          resume: null,
          secret: 's_test',
          maxPostBytes: 1024,
        },
        null,
      ]),
    );
  }

  drop(code = 1006): void {
    this.closed = true;
    this.options.events.close(code, '', false);
  }

  /** A POST failed before any POST worked: the transport cannot carry data here. */
  postFailedFirst(): void {
    this.options.events.unusable();
    this.drop();
  }

  transport(): Transport {
    return {
      name: 'sse',
      protocol: '',
      webSocket: null,
      reportsStable: true,
      isOpen: () => !this.closed,
      send: () => {},
      sendControl: () => {},
      bufferedAmount: () => 0,
      close: () => {
        this.closed = true;
      },
      dispose: () => {
        this.closed = true;
      },
    };
  }
}

function fakeSse(): TransportFactory {
  return {
    name: 'sse',
    open(options) {
      return new FakeSse(options).transport();
    },
  };
}

const build = client<SocketContract>();

describe('a custom transport that fires events inside open()', () => {
  it('opens the socket when the events come before open() returns', async () => {
    const socket = build(
      connect(url, {
        transports: [
          {
            name: 'sse',
            open(options) {
              const transport = new FakeSse(options).transport();
              options.events.open();
              options.events.message(
                JSON.stringify([
                  '__connected__',
                  {
                    pingIntervalMs: null,
                    idleTimeoutMs: null,
                    maxResumeTokens: 8,
                    connectionId: 'c_sync',
                    features: [],
                    resume: null,
                    secret: 's',
                    maxPostBytes: 1024,
                  },
                  null,
                ]),
              );
              return transport;
            },
          },
        ],
      }),
    );
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await opened(() => FakeSse.opened.length, 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(socket.state.get()).toBe('open');
  });
});

interface HuddleContract {
  incoming: { 'message-created': { text: string } };
  outgoing: {};
}

const url = 'wss://huddle.test/huddle';

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  FakeSse.opened = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

/** Let the async connect path run, without moving the clock, until `count()` is `expected`. */
async function opened(count: () => number, expected: number): Promise<void> {
  for (let i = 0; i < 20 && count() !== expected; i++) await vi.advanceTimersByTimeAsync(0);

  expect(count()).toBe(expected);
}

/** Past the 1 ms reconnection delay, and well short of the 5 s connect timeout. */
async function retryWait(): Promise<void> {
  await vi.advanceTimersByTimeAsync(100);
}

describe('failover while connecting', () => {
  it('moves to sse when the WebSocket drops with 1006, and marks the WebSocket', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    const closes: number[] = [];
    socket.onClose((event) => closes.push(event.code));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);

    await opened(() => FakeSse.opened.length, 1);
    expect(socket.state.get()).toBe('connecting');
    FakeSse.last().connected();

    expect(socket.state.get()).toBe('open');
    expect(socket.transport.get()).toBe('sse');
    // The app never saw the WebSocket fail.
    expect(closes).toEqual([]);

    // The next open skips the marked WebSocket.
    socket.disconnect();
    socket.connect();
    await opened(() => FakeSse.opened.length, 2);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('moves to sse when the WebSocket never sends __connected__', async () => {
    const socket = build(
      connect(url, { transports: [websocket(), fakeSse()], connectTimeoutMs: 1_000 }),
    );
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    // A proxy that accepts the upgrade and passes nothing.
    MockWebSocket.last().open('', null);

    await vi.advanceTimersByTimeAsync(1_000);

    await opened(() => FakeSse.opened.length, 1);
    // The browser's close() during the handshake ends the stalled WebSocket.
    expect(MockWebSocket.last().closeCall).toBeDefined();
    FakeSse.last().connected();
    expect(socket.transport.get()).toBe('sse');
  });

  it('ignores a late frame from the abandoned WebSocket', async () => {
    const socket = build(
      connect(url, { transports: [websocket(), fakeSse()], connectTimeoutMs: 1_000 }),
    );
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    const stalled = MockWebSocket.last();
    stalled.open('', null);

    await vi.advanceTimersByTimeAsync(1_000);
    await opened(() => FakeSse.opened.length, 1);

    stalled.connected();

    expect(socket.state.get()).toBe('connecting');
    FakeSse.last().connected();
    expect(socket.transport.get()).toBe('sse');
  });

  it('marks nothing when no transport connects, and tries the WebSocket first again', async () => {
    const socket = build(
      connect(url, { transports: [websocket(), fakeSse()] }),
      reconnection({ maxDelay: 1 }),
    );
    const closes: number[] = [];
    socket.onClose((event) => closes.push(event.code));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);
    FakeSse.last().drop();

    // Only the last failure reaches the app, and reconnection() backs off.
    expect(closes).toEqual([1006]);
    expect(socket.state.get()).toBe('reconnecting');

    await retryWait();
    await opened(() => MockWebSocket.instances.length, 2);
  });

  it('does not fail over on a close with a code, which is the final answer', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    const closes: number[] = [];
    socket.onClose((event) => closes.push(event.code));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(CloseCodes.AUTH_INVALID);

    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSse.opened).toHaveLength(0);
    expect(closes).toEqual([CloseCodes.AUTH_INVALID]);
  });

  it('tries the WebSocket again after 5 minutes', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);

    FakeSse.last().connected();
    socket.disconnect();

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    socket.connect();

    await opened(() => MockWebSocket.instances.length, 2);
  });

  it('tries every transport in order when all are marked', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);

    FakeSse.last().connected();
    // SSE now fails its first POST, so it is marked too.
    FakeSse.last().postFailedFirst();
    socket.disconnect();

    socket.connect();

    await opened(() => MockWebSocket.instances.length, 2);
  });

  it('a lazy socket fails over the same way when it opens', async () => {
    const socket = client<HuddleContract>()(
      connect(url, { transports: [websocket(), fakeSse()], lazy: true }),
    );
    const stop = socket.on('message-created', () => {});

    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);
    FakeSse.last().connected();

    expect(socket.transport.get()).toBe('sse');
    stop();
  });
});

describe('what the app sees during a failover', () => {
  it('gets no error for a transport that failed over, and one token() call', async () => {
    const token = vi.fn(() => 'kofi-session');
    const socket = build(connect(url, { transports: [websocket(), fakeSse()], token }));
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().onerror?.({});
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);

    FakeSse.last().connected();

    expect(errors).toEqual([]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(FakeSse.last().options.token).toBe('kofi-session');
  });

  it('still reports a bad __connected__ frame, which is final', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    const errors: unknown[] = [];
    const closes: number[] = [];
    socket.onError((error) => errors.push(error));
    socket.onClose((event) => closes.push(event.code));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().open('', null);
    MockWebSocket.last().emit(['__connected__', { bogus: 1 }, null]);

    expect(closes).toEqual([CloseCodes.PROTOCOL_ERROR]);
    expect(errors).toHaveLength(1);
    expect(FakeSse.opened).toHaveLength(0);
  });

  it('a disconnect() while the second transport connects ends it, with no third try', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().serverClose(1006);
    await opened(() => FakeSse.opened.length, 1);

    const second = FakeSse.last();

    socket.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    second.connected();

    expect(second.closed).toBe(true);
    expect(socket.state.get()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('ignores a late frame from an abandoned sse', async () => {
    const socket = build(
      connect(url, { transports: [fakeSse(), websocket()], connectTimeoutMs: 1_000 }),
    );
    socket.connect();
    await opened(() => FakeSse.opened.length, 1);
    const stalled = FakeSse.last();
    await vi.advanceTimersByTimeAsync(1_000);

    await opened(() => MockWebSocket.instances.length, 1);

    stalled.connected();

    expect(socket.state.get()).toBe('connecting');
    MockWebSocket.last().open();
    expect(socket.transport.get()).toBe('websocket');
  });

  it('waits 5 s for each transport by default when it has several', async () => {
    const socket = build(connect(url, { transports: [websocket(), fakeSse()] }));
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().open('', null);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(FakeSse.opened).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    await opened(() => FakeSse.opened.length, 1);
  });

  it('moves on when a transport throws while it opens', async () => {
    const broken: TransportFactory = {
      name: 'sse',
      open() {
        throw new Error('no fetch here');
      },
    };

    const socket = build(connect(url, { transports: [broken, websocket()] }));
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().open();

    expect(socket.transport.get()).toBe('websocket');
    expect(errors).toEqual([]);
  });
});

describe('failure after the open', () => {
  it('marks sse at once when a POST fails before any POST worked', async () => {
    const socket = build(
      connect(url, { transports: [fakeSse(), websocket()] }),
      reconnection({ maxDelay: 1 }),
    );
    socket.connect();
    await opened(() => FakeSse.opened.length, 1);
    FakeSse.last().connected();

    FakeSse.last().postFailedFirst();
    expect(socket.state.get()).toBe('reconnecting');

    await retryWait();
    await opened(() => MockWebSocket.instances.length, 1);
    expect(FakeSse.opened).toHaveLength(1);
  });

  it('a plain drop after the open marks nothing', async () => {
    const socket = build(
      connect(url, { transports: [fakeSse(), websocket()] }),
      reconnection({ maxDelay: 1 }),
    );
    socket.connect();
    await opened(() => FakeSse.opened.length, 1);
    FakeSse.last().connected();

    FakeSse.last().drop();
    await retryWait();

    await opened(() => FakeSse.opened.length, 2);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('a WebSocket that connects then fails on use is not marked', async () => {
    const socket = build(
      connect(url, { transports: [websocket(), fakeSse()] }),
      reconnection({ maxDelay: 1 }),
    );
    socket.connect();
    await opened(() => MockWebSocket.instances.length, 1);
    MockWebSocket.last().open();
    MockWebSocket.last().serverClose(1006);

    await retryWait();

    await opened(() => MockWebSocket.instances.length, 2);
    expect(FakeSse.opened).toHaveLength(0);
  });

  it('the attempt counter resets only when sse reports stable, not at the open', async () => {
    const socket = build(connect(url, { transports: [fakeSse()] }), reconnection({ maxDelay: 1 }));
    socket.connect();
    await opened(() => FakeSse.opened.length, 1);
    FakeSse.last().drop();
    await retryWait();

    await opened(() => FakeSse.opened.length, 2);

    // Opened, but not proved: the next drop is the second attempt.
    FakeSse.last().connected();
    FakeSse.last().drop();
    expect(socket.reconnection.get().attempt).toBe(2);
    await retryWait();
    await opened(() => FakeSse.opened.length, 3);

    // Proved: the next drop starts again at the first attempt.
    FakeSse.last().connected();
    FakeSse.last().options.events.stable();
    FakeSse.last().drop();
    expect(socket.reconnection.get().attempt).toBe(1);
  });
});
