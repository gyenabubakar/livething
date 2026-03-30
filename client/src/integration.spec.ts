/* oxlint-disable @typescript-eslint/no-explicit-any -- integration test file */
import { PlatformAdapter } from '@/adapter.ts';
import { createSocket } from '@/create-socket.ts';
import { DisconnectedError, TimeoutError } from '@/errors.ts';
import { Ack } from '@/plugins/ack.ts';
import { Channels } from '@/plugins/channels.ts';
import { Dedup } from '@/plugins/dedup.ts';
import { Replay } from '@/plugins/replay.ts';
import { RequestResponse } from '@/plugins/request-response.ts';
import { Stream } from '@/plugins/stream.ts';
import {
  collectServerMessages,
  getMswServer,
  link,
  onceClose,
  onceOpen,
  onceReconnect,
  parseMessage,
  waitFor,
  WS_URL,
} from '@/test-helpers.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NetworkState, VisibilityState } from '@/adapter.ts';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

interface BareContract {
  incoming: {
    greeting: { text: string };
    notification: { id: string; body: string };
    'seq-msg': { text: string };
    'ai-response': { text: string };
  };
  outgoing: {
    chat: { text: string };
    ping: {};
  };
}

interface FullContract {
  incoming: {
    greeting: { text: string };
    notification: { id: string };
    'ai-response': { text: string };
  };
  outgoing: {
    chat: { text: string };
  };
  channels: {
    lobby: {
      incoming: { message: { text: string; from: string } };
      outgoing: { 'send-message': { text: string } };
      requests: {
        'get-history': { payload: { limit: number }; response: { messages: string[] } };
      };
    };
    alerts: {
      incoming: { alert: { level: string; text: string } };
    };
  };
  requests: {
    'get-balance': { payload: { userId: string }; response: { balance: number } };
    'get-profile': { payload: { userId: string }; response: { name: string } };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIntSocket<T extends Record<string, any>>(
  urlOrOpts?: string | (() => string | Promise<string>) | Record<string, any>,
  opts?: Record<string, any>,
) {
  const isUrlArg = typeof urlOrOpts === 'string' || typeof urlOrOpts === 'function';
  const url = isUrlArg ? urlOrOpts : WS_URL;
  const options = isUrlArg ? (opts ?? {}) : (urlOrOpts ?? {});
  return createSocket<T>(url as any, { pingInterval: 0, ...options } as any);
}

function createMockAdapter() {
  const adapter = new PlatformAdapter();
  const listeners: {
    visibility: ((state: VisibilityState) => void)[];
    network: ((state: NetworkState) => void)[];
  } = { visibility: [], network: [] };

  adapter.onVisibilityChange = vi.fn((callback: (state: VisibilityState) => void) => {
    listeners.visibility.push(callback);
    return () => {
      const idx = listeners.visibility.indexOf(callback);
      if (idx >= 0) listeners.visibility.splice(idx, 1);
    };
  });

  adapter.onNetworkChange = vi.fn((callback: (state: NetworkState) => void) => {
    listeners.network.push(callback);
    return () => {
      const idx = listeners.network.indexOf(callback);
      if (idx >= 0) listeners.network.splice(idx, 1);
    };
  });

  return {
    adapter,
    emit: {
      visibility: (state: VisibilityState) => listeners.visibility.forEach((cb) => cb(state)),
      network: (state: NetworkState) => listeners.network.forEach((cb) => cb(state)),
    },
  };
}

function sendJson(
  client: { send: (data: string) => void },
  event: string,
  payload: Record<string, unknown>,
) {
  client.send(JSON.stringify({ event, payload }));
}

// ---------------------------------------------------------------------------
// MSW setup
// ---------------------------------------------------------------------------

const server = getMswServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ==========================================================================
// Group 1: No plugins
// ==========================================================================

describe('Integration: No plugins', () => {
  it('full lifecycle round-trip', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = parseMessage(event.data as string);
          if (msg.event === 'chat') {
            sendJson(client, 'greeting', { text: 'echo' });
          }
        });
      }),
    );

    const socket = createIntSocket<BareContract>();
    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const received: string[] = [];
    socket.on('greeting', (data) => received.push(data.text));
    socket.send('chat', { text: 'hello' });

    await waitFor(100);
    expect(received).toEqual(['echo']);

    socket.disconnect();
  });

  it('reconnection preserves handlers', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        } else {
          setTimeout(() => sendJson(client, 'greeting', { text: 'after-reconnect' }), 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({ maxReconnectAttempts: 3 });
    const received: string[] = [];
    socket.on('greeting', (data) => received.push(data.text));

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;
    await waitFor(200);

    expect(received).toContain('after-reconnect');
    socket.disconnect();
  });

  it('buffers messages across reconnection', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        received = collectServerMessages(client);
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({
      bufferWhileDisconnected: true,
      maxReconnectAttempts: 3,
    });
    const firstOpen = onceOpen(socket as any);
    socket.connect();
    await firstOpen;

    const reconnected = onceReconnect(socket as any);
    await waitFor(200);
    socket.send('chat', { text: 'buffered-msg' });
    await reconnected;
    await waitFor(100);

    const found = received.find((r) => {
      const p = parseMessage(r);
      return p.event === 'chat' && (p.payload as any).text === 'buffered-msg';
    });
    expect(found).toBeDefined();

    socket.disconnect();
  });

  it('lazy mode triggers connect on on(), closes on idle', { timeout: 10_000 }, async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => sendJson(client, 'greeting', { text: 'lazy-msg' }), 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ lazy: true, lazyIdleTimeout: 500 });
    expect(socket.getState()).toBe('closed');

    const received: string[] = [];
    const opened = onceOpen(socket as any);
    const unsub = socket.on('greeting', (data) => received.push(data.text));
    await opened;
    await waitFor(200);

    expect(received).toContain('lazy-msg');

    unsub();
    await waitFor(700);
    expect(socket.getState()).toBe('closed');

    socket.disconnect();
  });

  it('searchParams called on connect and reconnect', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        }
      }),
    );

    const paramsFn = vi.fn(() => new URLSearchParams({ token: 'abc' }));
    const socket = createIntSocket<BareContract>({
      searchParams: paramsFn,
      maxReconnectAttempts: 3,
    });

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;

    expect(paramsFn).toHaveBeenCalledTimes(2);
    socket.disconnect();
  });

  it('dynamic URL called on connect and reconnect', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        }
      }),
    );

    const urlFn = vi.fn(() => WS_URL);
    const socket = createIntSocket<BareContract>(urlFn as any, { maxReconnectAttempts: 3 });

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;

    expect(urlFn).toHaveBeenCalledTimes(2);
    socket.disconnect();
  });

  it('middleware transforms and drops messages', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'greeting', { text: 'keep-this' });
          sendJson(client, 'notification', { id: 'drop-me', body: 'nope' });
          sendJson(client, 'greeting', { text: 'also-keep' });
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>();

    // Transform: rename greeting to notification
    socket.use((msg) => {
      if (msg.event === 'greeting') return { event: 'notification', payload: msg.payload };
    });

    // Drop: notifications with id 'drop-me'
    socket.use((msg) => {
      if (msg.event === 'notification' && (msg.payload as any).id === 'drop-me') return null;
    });

    const received: unknown[] = [];
    socket.on('notification', (data) => received.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ text: 'keep-this' });
    expect(received[1]).toEqual({ text: 'also-keep' });

    socket.disconnect();
  });

  it('custom serialize/parse round-trip', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const raw = event.data as string;
          const [evt] = raw.split('|');
          if (evt === 'chat') {
            client.send(`greeting|${JSON.stringify({ text: 'reply' })}`);
          }
        });
      }),
    );

    const socket = createIntSocket<BareContract>({
      parse: (raw: string) => {
        const idx = raw.indexOf('|');
        if (idx < 0) return null;
        return { event: raw.slice(0, idx), payload: JSON.parse(raw.slice(idx + 1)) };
      },
      serialize: (event: string, payload: unknown) => `${event}|${JSON.stringify(payload)}`,
    });

    const received: string[] = [];
    socket.on('greeting', (data) => received.push(data.text));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    socket.send('chat', { text: 'hello' });

    await waitFor(100);
    expect(received).toEqual(['reply']);

    socket.disconnect();
  });

  it('shouldReconnect suppresses reconnection', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => client.close(4100, 'banned'), 50);
      }),
    );

    const socket = createIntSocket<BareContract>({
      shouldReconnect: (code: number) => (code === 4100 ? false : undefined),
    });

    const closed = onceClose(socket as any);
    socket.connect();
    await closed;
    await waitFor(100);

    expect(socket.getState()).toBe('closed');
    socket.disconnect();
  });

  it('nonRetryableCodes suppresses reconnection', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => client.close(4200, 'go away'), 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ nonRetryableCodes: [4200] });

    const closed = onceClose(socket as any);
    socket.connect();
    await closed;
    await waitFor(100);

    expect(socket.getState()).toBe('closed');
    socket.disconnect();
  });

  it('onOpen and onReconnect fire correct counts', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({ maxReconnectAttempts: 3 });
    let openCount = 0;
    let reconnectCount = 0;
    socket.onOpen(() => openCount++);
    socket.onReconnect(() => reconnectCount++);

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;

    expect(openCount).toBe(2);
    expect(reconnectCount).toBe(1);

    socket.disconnect();
  });

  it('send returns false when disconnected and not buffering', () => {
    const socket = createIntSocket<BareContract>();
    const result = socket.send('chat', { text: 'hello' });
    expect(result).toBe(false);
    socket.disconnect();
  });

  it('handlers survive connect/disconnect/connect cycle', async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 2) {
          setTimeout(() => sendJson(client, 'greeting', { text: 'second' }), 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>();
    const received: string[] = [];
    socket.on('greeting', (data) => received.push(data.text));

    const firstOpen = onceOpen(socket as any);
    socket.connect();
    await firstOpen;
    socket.disconnect();

    const secondOpen = onceOpen(socket as any);
    socket.connect();
    await secondOpen;
    await waitFor(200);

    expect(received).toContain('second');
    socket.disconnect();
  });
});

// ==========================================================================
// Group 2: Channels
// ==========================================================================

describe('Integration: Channels', () => {
  it('routes channel messages to channel handler, not top-level', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'message', { _channel: 'lobby', text: 'hi', from: 'server' });
        }, 50);
      }),
    );

    const socket = createIntSocket<FullContract>({
      plugins: [new Channels()],
    });

    const channelReceived: any[] = [];
    const topLevelReceived: any[] = [];
    (socket as any).channel('lobby').on('message', (data: any) => channelReceived.push(data));
    socket.on('greeting', (data: any) => topLevelReceived.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(channelReceived).toHaveLength(1);
    expect(channelReceived[0]._channel).toBe('lobby');
    expect(channelReceived[0].text).toBe('hi');
    expect(topLevelReceived).toHaveLength(0);

    socket.disconnect();
  });

  it('channel send tags message with _channel', async () => {
    let received: string[] = [];
    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    const socket = createIntSocket<FullContract>({
      plugins: [new Channels()],
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    (socket as any).channel('lobby').send('send-message', { text: 'hello' });
    await waitFor(100);

    const msg = received.map((r) => parseMessage(r)).find((m) => m.event === 'send-message');
    expect(msg).toBeDefined();
    expect((msg!.payload as any)._channel).toBe('lobby');
    expect((msg!.payload as any).text).toBe('hello');

    socket.disconnect();
  });

  it('multiple channels receive only their own events', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'message', { _channel: 'lobby', text: 'lobby-msg', from: 'a' });
          sendJson(client, 'alert', { _channel: 'alerts', level: 'info', text: 'alert-msg' });
        }, 50);
      }),
    );

    const socket = createIntSocket<FullContract>({
      plugins: [new Channels()],
    });

    const lobbyMessages: any[] = [];
    const alertMessages: any[] = [];
    (socket as any).channel('lobby').on('message', (data: any) => lobbyMessages.push(data));
    (socket as any).channel('alerts').on('alert', (data: any) => alertMessages.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(lobbyMessages).toHaveLength(1);
    expect(lobbyMessages[0].text).toBe('lobby-msg');
    expect(alertMessages).toHaveLength(1);
    expect(alertMessages[0].text).toBe('alert-msg');

    socket.disconnect();
  });

  it('top-level events bypass channels', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'greeting', { text: 'top-level' });
        }, 50);
      }),
    );

    const socket = createIntSocket<FullContract>({
      plugins: [new Channels()],
    });

    const topLevel: any[] = [];
    const channelLevel: any[] = [];
    socket.on('greeting', (data) => topLevel.push(data));
    (socket as any).channel('lobby').on('message', (data: any) => channelLevel.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].text).toBe('top-level');
    expect(channelLevel).toHaveLength(0);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 3: Channels + RequestResponse
// ==========================================================================

describe('Integration: Channels + RequestResponse', () => {
  function createRequestSocket() {
    return createIntSocket<FullContract>({
      plugins: [new Channels(), new RequestResponse()],
    });
  }

  function setupRequestEchoServer() {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = parseMessage(event.data as string);
          const payload = msg.payload as Record<string, any>;

          if (msg.event === 'get-balance' && payload._correlationId) {
            sendJson(client, 'get-balance', {
              _correlationId: payload._correlationId,
              balance: 42,
            });
          }
          if (msg.event === 'get-profile' && payload._correlationId) {
            sendJson(client, 'get-profile', {
              _correlationId: payload._correlationId,
              name: 'Alice',
            });
          }
          if (msg.event === 'get-history' && payload._correlationId) {
            sendJson(client, 'get-history', {
              _correlationId: payload._correlationId,
              _channel: payload._channel,
              messages: ['msg1', 'msg2'],
            });
          }
        });
      }),
    );
  }

  it('top-level request round-trip', async () => {
    setupRequestEchoServer();
    const socket = createRequestSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const result = await (socket as any).request('get-balance', { userId: '1' });
    expect(result.balance).toBe(42);

    socket.disconnect();
  });

  it('channel-level request round-trip', async () => {
    setupRequestEchoServer();
    const socket = createRequestSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const result = await (socket as any).channel('lobby').request('get-history', { limit: 10 });
    expect(result.messages).toEqual(['msg1', 'msg2']);

    socket.disconnect();
  });

  it('request rejects with TimeoutError', async () => {
    server.use(link.addEventListener('connection', () => {}));
    const socket = createRequestSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    await expect(
      (socket as any).request('get-balance', { userId: '1' }, { timeout: 100 }),
    ).rejects.toThrow(TimeoutError);

    socket.disconnect();
  });

  it('request rejects with DisconnectedError on disconnect', async () => {
    server.use(link.addEventListener('connection', () => {}));
    const socket = createRequestSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const requestPromise = (socket as any).request('get-balance', { userId: '1' });
    socket.disconnect();

    await expect(requestPromise).rejects.toThrow(DisconnectedError);
  });

  it('multiple concurrent requests resolve independently', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        const pending: { event: string; id: string; response: Record<string, any> }[] = [];

        client.addEventListener('message', (event) => {
          const msg = parseMessage(event.data as string);
          const payload = msg.payload as Record<string, any>;
          if (!payload._correlationId) return;

          if (msg.event === 'get-balance') {
            pending.push({
              event: 'get-balance',
              id: payload._correlationId,
              response: { balance: Number(payload.userId) * 10 },
            });
          }
          if (msg.event === 'get-profile') {
            pending.push({
              event: 'get-profile',
              id: payload._correlationId,
              response: { name: `user-${payload.userId}` },
            });
          }
        });

        // Respond in reverse order after a delay
        setTimeout(() => {
          for (const p of pending.reverse()) {
            sendJson(client, p.event, { _correlationId: p.id, ...p.response });
          }
        }, 100);
      }),
    );

    const socket = createRequestSocket();
    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const [balance1, profile, balance2] = await Promise.all([
      (socket as any).request('get-balance', { userId: '1' }),
      (socket as any).request('get-profile', { userId: '2' }),
      (socket as any).request('get-balance', { userId: '3' }),
    ]);

    expect(balance1.balance).toBe(10);
    expect(profile.name).toBe('user-2');
    expect(balance2.balance).toBe(30);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 4: Channels + Ack
// ==========================================================================

describe('Integration: Channels + Ack', () => {
  function createAckSocket() {
    return createIntSocket<FullContract>({
      plugins: [new Channels(), new Ack()],
    });
  }

  function setupAckServer() {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = parseMessage(event.data as string);
          const payload = msg.payload as Record<string, any>;
          if (payload._ackId) {
            sendJson(client, '_ack', { id: payload._ackId });
          }
        });
      }),
    );
  }

  it('top-level send.withAck resolves on ack', async () => {
    setupAckServer();
    const socket = createAckSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    await (socket as any).send.withAck('chat', { text: 'acked-msg' });
    // If we get here without throwing, the ack was received

    socket.disconnect();
  });

  it('channel send.withAck resolves on ack', async () => {
    setupAckServer();
    const socket = createAckSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    await (socket as any).channel('lobby').send.withAck('send-message', { text: 'acked' });

    socket.disconnect();
  });

  it('ack rejects with TimeoutError', async () => {
    server.use(link.addEventListener('connection', () => {}));
    const socket = createAckSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    await expect(
      (socket as any).send.withAck('chat', { text: 'no-ack' }, { timeout: 100 }),
    ).rejects.toThrow(TimeoutError);

    socket.disconnect();
  });

  it('ack rejects with DisconnectedError on disconnect', async () => {
    server.use(link.addEventListener('connection', () => {}));
    const socket = createAckSocket();

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const ackPromise = (socket as any).send.withAck('chat', { text: 'pending' });
    socket.disconnect();

    await expect(ackPromise).rejects.toThrow(DisconnectedError);
  });
});

// ==========================================================================
// Group 5: Dedup
// ==========================================================================

describe('Integration: Dedup', () => {
  it('drops duplicate messages with same _messageId', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'greeting', { text: 'first', _messageId: 'dup-1' } as any);
          sendJson(client, 'greeting', { text: 'duplicate', _messageId: 'dup-1' } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Dedup()] });
    const received: any[] = [];
    socket.on('greeting', (data) => received.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('first');

    socket.disconnect();
  });

  it('different IDs pass through', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'greeting', { text: 'a', _messageId: 'id-1' } as any);
          sendJson(client, 'greeting', { text: 'b', _messageId: 'id-2' } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Dedup()] });
    const received: any[] = [];
    socket.on('greeting', (data) => received.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(received).toHaveLength(2);

    socket.disconnect();
  });

  it('messages without _messageId are always delivered', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'greeting', { text: 'no-id-1' });
          sendJson(client, 'greeting', { text: 'no-id-2' });
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Dedup()] });
    const received: any[] = [];
    socket.on('greeting', (data) => received.push(data));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(received).toHaveLength(2);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 6: Replay
// ==========================================================================

describe('Integration: Replay', () => {
  it('sends _replay request on reconnect with last seen _seq', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        received = collectServerMessages(client);
        if (connectionCount === 1) {
          setTimeout(() => {
            sendJson(client, 'seq-msg', { text: 'a', _seq: 1 } as any);
            sendJson(client, 'seq-msg', { text: 'b', _seq: 2 } as any);
            sendJson(client, 'seq-msg', { text: 'c', _seq: 5 } as any);
          }, 50);
          setTimeout(() => client.close(4000, 'drop'), 300);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({
      plugins: [new Replay()],
      maxReconnectAttempts: 3,
    });

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;
    await waitFor(100);

    const replayMsg = received.map((r) => parseMessage(r)).find((m) => m.event === '_replay');
    expect(replayMsg).toBeDefined();
    expect((replayMsg!.payload as any).since).toBe(5);

    socket.disconnect();
  });

  it('does not send _replay on first connect', async () => {
    let received: string[] = [];
    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Replay()] });
    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    const replayMsg = received.map((r) => parseMessage(r)).find((m) => m.event === '_replay');
    expect(replayMsg).toBeUndefined();

    socket.disconnect();
  });
});

// ==========================================================================
// Group 7: Dedup + Replay
// ==========================================================================

describe('Integration: Dedup + Replay', () => {
  it('replayed duplicates are deduplicated', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => {
            sendJson(client, 'seq-msg', { text: 'a', _seq: 1, _messageId: 'msg-a' } as any);
            sendJson(client, 'seq-msg', { text: 'b', _seq: 2, _messageId: 'msg-b' } as any);
          }, 50);
          setTimeout(() => client.close(4000, 'drop'), 300);
        } else {
          // Replay: resend the same messages
          setTimeout(() => {
            sendJson(client, 'seq-msg', { text: 'a', _seq: 1, _messageId: 'msg-a' } as any);
            sendJson(client, 'seq-msg', { text: 'b', _seq: 2, _messageId: 'msg-b' } as any);
            sendJson(client, 'seq-msg', { text: 'c', _seq: 3, _messageId: 'msg-c' } as any);
          }, 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({
      plugins: [new Dedup(), new Replay()],
      maxReconnectAttempts: 3,
    });

    const received: string[] = [];
    socket.on('seq-msg', (data) => received.push(data.text));

    const reconnected = onceReconnect(socket as any);
    socket.connect();
    await reconnected;
    await waitFor(300);

    // 'a' and 'b' from first connection, only 'c' from replay (duplicates dropped)
    expect(received).toEqual(['a', 'b', 'c']);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 8: Stream
// ==========================================================================

describe('Integration: Stream', () => {
  it('stream lifecycle: onChunk fires per chunk, onEnd fires at end', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'ai-response', { text: 'chunk1', _streamId: 's1' } as any);
          sendJson(client, 'ai-response', { text: 'chunk2', _streamId: 's1' } as any);
          sendJson(client, 'ai-response', {
            text: 'chunk3',
            _streamId: 's1',
            _streamEnd: true,
          } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Stream()] });

    const chunks: string[] = [];
    let endedStreamId: string | null = null;

    (socket as any).onStream('ai-response', {
      onChunk: (chunk: any) => chunks.push(chunk.text),
      onEnd: (id: string) => {
        endedStreamId = id;
      },
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(300);

    expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
    expect(endedStreamId).toBe('s1');

    socket.disconnect();
  });

  it('on() and onStream() both fire for stream messages', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'ai-response', { text: 'data', _streamId: 's2' } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Stream()] });

    const onReceived: any[] = [];
    const streamChunks: any[] = [];

    socket.on('ai-response', (data) => onReceived.push(data));
    (socket as any).onStream('ai-response', {
      onChunk: (chunk: any) => streamChunks.push(chunk),
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(200);

    expect(onReceived).toHaveLength(1);
    expect(streamChunks).toHaveLength(1);

    socket.disconnect();
  });

  it('multiple concurrent streams tracked independently', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'ai-response', { text: 'a1', _streamId: 'sa' } as any);
          sendJson(client, 'ai-response', { text: 'b1', _streamId: 'sb' } as any);
          sendJson(client, 'ai-response', { text: 'a2', _streamId: 'sa', _streamEnd: true } as any);
          sendJson(client, 'ai-response', { text: 'b2', _streamId: 'sb', _streamEnd: true } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Stream()] });

    const ended: string[] = [];
    (socket as any).onStream('ai-response', {
      onChunk: () => {},
      onEnd: (streamId: string) => ended.push(streamId),
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(300);

    expect(ended).toContain('sa');
    expect(ended).toContain('sb');
    expect(ended).toHaveLength(2);

    socket.disconnect();
  });

  it('unsubscribe stops stream callbacks', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => {
          sendJson(client, 'ai-response', { text: 'before', _streamId: 'su' } as any);
        }, 50);
        setTimeout(() => {
          sendJson(client, 'ai-response', { text: 'after', _streamId: 'su2' } as any);
        }, 200);
      }),
    );

    const socket = createIntSocket<BareContract>({ plugins: [new Stream()] });

    const chunks: string[] = [];
    const unsub = (socket as any).onStream('ai-response', {
      onChunk: (chunk: any) => chunks.push(chunk.text),
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;
    await waitFor(100);

    unsub();
    await waitFor(200);

    expect(chunks).toEqual(['before']);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 9: Full plugin suite
// ==========================================================================

describe('Integration: Full plugin suite', () => {
  it('all 6 plugins work together on one connection', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = parseMessage(event.data as string);
          const payload = msg.payload as Record<string, any>;

          // Respond to requests
          if (payload._correlationId) {
            if (msg.event === 'get-balance') {
              sendJson(client, 'get-balance', {
                _correlationId: payload._correlationId,
                balance: 100,
              });
            }
            if (msg.event === 'get-history') {
              sendJson(client, 'get-history', {
                _correlationId: payload._correlationId,
                _channel: payload._channel,
                messages: ['history'],
              });
            }
          }

          // Ack outgoing messages
          if (payload._ackId) {
            sendJson(client, '_ack', { id: payload._ackId });
          }
        });

        // Stream some data
        setTimeout(() => {
          sendJson(client, 'ai-response', {
            text: 'token1',
            _streamId: 'ks',
            _seq: 1,
            _messageId: 'km1',
          } as any);
          sendJson(client, 'ai-response', {
            text: 'token2',
            _streamId: 'ks',
            _streamEnd: true,
            _seq: 2,
            _messageId: 'km2',
          } as any);
        }, 50);
      }),
    );

    const socket = createIntSocket<FullContract>({
      plugins: [
        new Channels(),
        new RequestResponse(),
        new Ack(),
        new Replay(),
        new Dedup(),
        new Stream(),
      ],
    });

    const streamChunks: string[] = [];
    let streamEnded = false;
    (socket as any).onStream('ai-response', {
      onChunk: (chunk: any) => streamChunks.push(chunk.text),
      onEnd: () => {
        streamEnded = true;
      },
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    // Top-level request
    const balance = await (socket as any).request('get-balance', { userId: '1' });
    expect(balance.balance).toBe(100);

    // Channel request
    const history = await (socket as any).channel('lobby').request('get-history', { limit: 5 });
    expect(history.messages).toEqual(['history']);

    // Channel send.withAck
    await (socket as any).channel('lobby').send.withAck('send-message', { text: 'acked' });

    // Stream should have completed
    await waitFor(200);
    expect(streamChunks).toEqual(['token1', 'token2']);
    expect(streamEnded).toBe(true);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 10: Dynamic channels (index signature contracts)
// ==========================================================================

interface DynamicContract {
  incoming: { status: { online: boolean } };
  outgoing: { ping: {} };
  channels: {
    [roomName: string]: {
      incoming: { message: { text: string; from: string } };
      outgoing: { 'send-message': { text: string } };
      requests: {
        'get-history': { payload: { limit: number }; response: { messages: string[] } };
      };
    };
  };
  requests: {
    'get-balance': { payload: { userId: string }; response: { balance: number } };
  };
}

describe('Integration: Dynamic channels', () => {
  it('routes messages to dynamically-named channels', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', () => {
          sendJson(client, 'message', { _channel: 'room-alpha', text: 'hello', from: 'server' });
          sendJson(client, 'message', { _channel: 'room-beta', text: 'world', from: 'server' });
        });
      }),
    );

    const socket = createIntSocket<DynamicContract>({
      plugins: [new Channels(), new RequestResponse(), new Ack()],
    });

    const alphaMessages: any[] = [];
    const betaMessages: any[] = [];

    (socket as any).channel('room-alpha').on('message', (d: any) => alphaMessages.push(d));
    (socket as any).channel('room-beta').on('message', (d: any) => betaMessages.push(d));

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    socket.send('ping', {});
    await waitFor(200);

    expect(alphaMessages).toHaveLength(1);
    expect(alphaMessages[0].text).toBe('hello');
    expect(betaMessages).toHaveLength(1);
    expect(betaMessages[0].text).toBe('world');

    socket.disconnect();
  });

  it('dynamic channel send tags with correct _channel', async () => {
    const received: string[] = [];
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          received.push(event.data as string);
        });
      }),
    );

    const socket = createIntSocket<DynamicContract>({
      plugins: [new Channels(), new RequestResponse(), new Ack()],
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    (socket as any).channel('room-xyz').send('send-message', { text: 'hi' });
    await waitFor(100);

    expect(received.length).toBeGreaterThan(0);
    const msg = parseMessage(received[0]!);
    expect(msg.event).toBe('send-message');
    expect((msg.payload as any)._channel).toBe('room-xyz');
    expect((msg.payload as any).text).toBe('hi');

    socket.disconnect();
  });

  it('dynamic channel request() round-trip', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          const payload = msg.payload as Record<string, unknown>;
          if (msg.event === 'get-history' && payload._correlationId) {
            sendJson(client, 'get-history', {
              _correlationId: payload._correlationId,
              _channel: payload._channel,
              messages: ['dynamic-msg-1', 'dynamic-msg-2'],
            });
          }
        });
      }),
    );

    const socket = createIntSocket<DynamicContract>({
      plugins: [new Channels(), new RequestResponse(), new Ack()],
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const result = await (socket as any)
      .channel('room-runtime')
      .request('get-history', { limit: 5 });
    expect(result.messages).toEqual(['dynamic-msg-1', 'dynamic-msg-2']);

    socket.disconnect();
  });

  it('dynamic channel send.withAck() round-trip', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          const payload = msg.payload as Record<string, unknown>;
          if (payload._ackId) {
            sendJson(client, '_ack', { id: payload._ackId as string });
          }
        });
      }),
    );

    const socket = createIntSocket<DynamicContract>({
      plugins: [new Channels(), new RequestResponse(), new Ack()],
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    await (socket as any).channel('room-ack-test').send.withAck('send-message', { text: 'ack me' });

    socket.disconnect();
  });

  it('multiple dynamic channels with concurrent requests resolve independently', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data as string);
          const payload = msg.payload as Record<string, unknown>;
          if (msg.event === 'get-history' && payload._correlationId) {
            const channel = payload._channel as string;
            sendJson(client, 'get-history', {
              _correlationId: payload._correlationId,
              _channel: channel,
              messages: [`from-${channel}`],
            });
          }
        });
      }),
    );

    const socket = createIntSocket<DynamicContract>({
      plugins: [new Channels(), new RequestResponse(), new Ack()],
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    const [r1, r2, r3] = await Promise.all([
      (socket as any).channel('room-a').request('get-history', { limit: 1 }),
      (socket as any).channel('room-b').request('get-history', { limit: 1 }),
      (socket as any).channel('room-c').request('get-history', { limit: 1 }),
    ]);

    expect(r1.messages).toEqual(['from-room-a']);
    expect(r2.messages).toEqual(['from-room-b']);
    expect(r3.messages).toEqual(['from-room-c']);

    socket.disconnect();
  });
});

// ==========================================================================
// Group 11: Custom adapter
// ==========================================================================

describe('Integration: Custom adapter', () => {
  it('network offline pauses reconnection, online resumes', { timeout: 10_000 }, async () => {
    let connectionCount = 0;
    const mock = createMockAdapter();

    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'drop'), 50);
        }
      }),
    );

    const socket = createIntSocket<BareContract>({
      adapter: mock.adapter,
      networkAware: true,
      maxReconnectAttempts: 5,
    });

    const firstOpen = onceOpen(socket as any);
    socket.connect();
    await firstOpen;

    // Go offline before the server drops
    mock.emit.network('offline');
    await waitFor(200);

    // Server dropped, socket in reconnecting but paused
    expect(socket.getState()).toBe('reconnecting');
    const countAfterOffline = connectionCount;

    // Wait and verify no reconnection attempts happen
    await waitFor(500);
    expect(connectionCount).toBe(countAfterOffline);

    // Come back online
    const reconnected = onceReconnect(socket as any);
    mock.emit.network('online');
    await reconnected;

    expect(connectionCount).toBeGreaterThan(countAfterOffline);
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  it('inactive timeout disconnects, active reconnects', { timeout: 10_000 }, async () => {
    const mock = createMockAdapter();

    server.use(link.addEventListener('connection', () => {}));

    const socket = createIntSocket<BareContract>({
      adapter: mock.adapter,
      inactiveTimeout: 300,
      maxReconnectAttempts: 5,
    });

    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    // Tab goes inactive
    mock.emit.visibility('inactive');
    await waitFor(500);
    expect(socket.getState()).toBe('closed');

    // Tab becomes active again
    const reopened = onceOpen(socket as any);
    mock.emit.visibility('active');
    await reopened;
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  it('no adapter in Node env — connect works, platform features disabled', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createIntSocket<BareContract>();
    const opened = onceOpen(socket as any);
    socket.connect();
    await opened;

    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });
});
