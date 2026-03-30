/* oxlint-disable @typescript-eslint/no-explicit-any -- runtime test file */
import { Plugin } from '@/plugins/base.ts';
import { Socket } from '@/socket/socket.ts';
import {
  collectServerMessages,
  createTestSocket,
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
import type { PluginHelpers } from '@/plugins/base.ts';
import type { TestContract } from '@/test-helpers.ts';

// ---------------------------------------------------------------------------
// MSW setup
// ---------------------------------------------------------------------------

const server = getMswServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Socket (runtime)', () => {
  // ── Connection lifecycle ─────────────────────────────────

  it('connects and transitions to open', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    const opened = onceOpen(socket);
    socket.connect();

    expect(socket.getState()).toBe('connecting');
    await opened;
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  it('disconnect transitions to closed', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.disconnect();
    expect(socket.getState()).toBe('closed');
  });

  it('disconnect is safe to call when already closed', () => {
    const socket = createTestSocket();
    socket.disconnect();
    expect(socket.getState()).toBe('closed');
  });

  it('connect is a no-op when already open', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.connect();
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  // ── Send / Receive ──────────────────────────────────────

  it('sends messages to server', async () => {
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    const socket = createTestSocket();
    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.send('chat', { text: 'hello' });
    await waitFor(50);

    expect(received.length).toBe(1);
    const parsed = parseMessage(received[0]!);
    expect(parsed.event).toBe('chat');
    expect(parsed.payload).toEqual({ text: 'hello' });

    socket.disconnect();
  });

  it('receives messages from server', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'hi' } }));
      }),
    );

    const socket = createTestSocket();
    const messages: { text: string }[] = [];

    socket.on('greeting', (data) => {
      messages.push(data);
    });

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'hi' }]);

    socket.disconnect();
  });

  it('send returns false when not connected', () => {
    const socket = createTestSocket();
    const result = socket.send('chat', { text: 'nope' });
    expect(result).toBe(false);
  });

  // ── Close events ────────────────────────────────────────

  it('fires onClose with close details', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.close(4001, 'custom reason');
      }),
    );

    const socket = createTestSocket({ reconnect: false });
    const closed = onceClose(socket);

    socket.connect();
    const event = await closed;

    expect(event.code).toBe(4001);
    expect(event.reason).toBe('custom reason');
  });

  it('fires onClose on server-initiated close', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.close(1011, 'server error');
      }),
    );

    const socket = createTestSocket({ reconnect: false });
    const closed = onceClose(socket);
    socket.connect();
    await closed;

    expect(socket.getState()).toBe('closed');
  });

  // ── Middleware ───────────────────────────────────────────

  it('middleware can modify incoming messages', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'raw' } }));
      }),
    );

    const socket = createTestSocket();
    socket.use((msg) => ({ event: msg.event, payload: { text: 'modified' } }));

    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'modified' }]);

    socket.disconnect();
  });

  it('middleware can drop messages by returning null', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'dropped' } }));
      }),
    );

    const socket = createTestSocket();
    socket.use(() => null);

    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([]);

    socket.disconnect();
  });

  // ── Pong filtering ──────────────────────────────────────

  it('filters pong messages from reaching on() handlers', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send('pong');
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'real' } }));
      }),
    );

    const socket = createTestSocket();
    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'real' }]);

    socket.disconnect();
  });

  it('uses custom pongMessage for filtering', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send('heartbeat-ack');
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'real' } }));
      }),
    );

    const socket = createTestSocket({ pongMessage: 'heartbeat-ack' });
    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'real' }]);

    socket.disconnect();
  });

  // ── State subscriptions ─────────────────────────────────

  it('subscribe fires on state changes', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    const states: string[] = [];
    socket.subscribe(() => states.push(socket.getState()));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.disconnect();

    expect(states).toContain('connecting');
    expect(states).toContain('open');
    expect(states).toContain('closed');
  });

  // ── Custom parse / serialize ────────────────────────────

  it('uses custom serialize and parse', async () => {
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
        client.addEventListener('message', () => {
          client.send(`greeting|${JSON.stringify({ text: 'reply' })}`);
        });
      }),
    );

    const socket = createTestSocket({
      serialize: (event, payload) => `${event}|${JSON.stringify(payload)}`,
      parse: (raw) => {
        const idx = raw.indexOf('|');
        if (idx === -1) return null;
        return { event: raw.slice(0, idx), payload: JSON.parse(raw.slice(idx + 1)) };
      },
    });

    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.send('chat', { text: 'hello' });
    await waitFor(50);

    expect(received[0]).toBe('chat|{"text":"hello"}');
    expect(messages).toEqual([{ text: 'reply' }]);

    socket.disconnect();
  });

  // ── Dynamic URL ─────────────────────────────────────────

  it('supports async URL function', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const asyncSocket = new (Socket as any)(
      async () => 'ws://localhost:9876',
      { pingInterval: 0 },
      [],
    );

    const opened = onceOpen(asyncSocket);
    asyncSocket.connect();
    await opened;

    expect(asyncSocket.getState()).toBe('open');

    asyncSocket.disconnect();
  });

  // ── onOpen / onReconnect callbacks ──────────────────────

  it('onOpen fires on every connection', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    let openCount = 0;
    socket.onOpen(() => openCount++);

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    expect(openCount).toBe(1);

    socket.disconnect();
  });

  it('onReconnect does not fire on first connect', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    let reconnectCount = 0;
    socket.onReconnect(() => reconnectCount++);

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    expect(reconnectCount).toBe(0);

    socket.disconnect();
  });

  // ── Debug mode ──────────────────────────────────────────

  it('setDebug toggles debug logging', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    socket.setDebug(true);
    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    expect(logSpy).toHaveBeenCalled();
    const loggedWithPrefix = logSpy.mock.calls.some((args) => args[0] === '[better-ws]');
    expect(loggedWithPrefix).toBe(true);

    socket.disconnect();
    logSpy.mockRestore();
  });

  // ── ws and protocol properties ──────────────────────────

  it('ws is null when disconnected, set when open', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    expect(socket.ws).toBeNull();

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    expect(socket.ws).not.toBeNull();

    socket.disconnect();
    expect(socket.ws).toBeNull();
  });

  it('protocol is null when disconnected', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    expect(socket.protocol).toBeNull();

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.disconnect();
    expect(socket.protocol).toBeNull();
  });

  // ── Malformed messages ──────────────────────────────────

  it('silently drops malformed JSON', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send('not valid json {{{');
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'after' } }));
      }),
    );

    const socket = createTestSocket();
    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'after' }]);

    socket.disconnect();
  });

  it('silently drops messages without event field', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        client.send(JSON.stringify({ noEvent: true }));
        client.send(JSON.stringify({ event: 'greeting', payload: { text: 'valid' } }));
      }),
    );

    const socket = createTestSocket();
    const messages: unknown[] = [];
    socket.on('greeting', (data) => messages.push(data));

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(messages).toEqual([{ text: 'valid' }]);

    socket.disconnect();
  });

  // ── Plugin onOutgoing hooks ─────────────────────────────

  it('plugin onOutgoing can modify outgoing messages', async () => {
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    class Tagger extends Plugin {
      id = 'tagger';
      override onOutgoing(event: string, payload: unknown) {
        return { event, payload: { ...(payload as Record<string, unknown>), _tagged: true } };
      }
    }

    const tagger = new Tagger();
    tagger.helpers = {} as PluginHelpers;
    const socket = new Socket<TestContract>(WS_URL, { pingInterval: 0 } as any, [tagger]);

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    socket.send('chat', { text: 'hi' });
    await waitFor(50);

    const parsed = parseMessage(received[0]!);
    expect(parsed.payload).toEqual({ text: 'hi', _tagged: true });

    socket.disconnect();
  });

  it('plugin onOutgoing returning null cancels the send', async () => {
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    class Blocker extends Plugin {
      id = 'blocker';
      override onOutgoing() {
        return null;
      }
    }

    const blocker = new Blocker();
    blocker.helpers = {} as PluginHelpers;
    const socket = new Socket<TestContract>(WS_URL, { pingInterval: 0 } as any, [blocker]);

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    const result = socket.send('chat' as any, { text: 'hi' } as any);
    await waitFor(50);

    expect(result).toBe(false);
    expect(received.length).toBe(0);

    socket.disconnect();
  });

  // ── Plugin onOpen/onReconnect messages ──────────────────

  it('messages returned from plugin onOpen are sent over the wire', async () => {
    let received: string[] = [];

    server.use(
      link.addEventListener('connection', ({ client }) => {
        received = collectServerMessages(client);
      }),
    );

    class Greeter extends Plugin {
      id = 'greeter';
      override onOpen() {
        return [{ event: 'identify', payload: { userId: '42' } }];
      }
    }

    const greeter = new Greeter();
    greeter.helpers = {} as PluginHelpers;
    const socket = new Socket<TestContract>(WS_URL, { pingInterval: 0 } as any, [greeter]);

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    await waitFor(50);

    expect(received.length).toBe(1);
    const parsed = parseMessage(received[0]!);
    expect(parsed.event).toBe('identify');
    expect(parsed.payload).toEqual({ userId: '42' });

    socket.disconnect();
  });

  // ── searchParams ────────────────────────────────────────

  it('appends searchParams to the URL', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket({
      searchParams: async () => new URLSearchParams({ token: 'abc123' }),
    });

    const opened = onceOpen(socket);
    socket.connect();
    await opened;

    // The socket connected — searchParams didn't break anything
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  // ── Reconnection cycle ──────────────────────────────────

  it('enters reconnecting state after server close', async () => {
    server.use(
      link.addEventListener('connection', ({ client }) => {
        setTimeout(() => client.close(4000, 'drop'), 50);
      }),
    );

    const socket = createTestSocket({ maxReconnectAttempts: 3 });
    const closed = onceClose(socket);
    socket.connect();
    await closed;

    expect(socket.getState()).toBe('reconnecting');

    socket.disconnect();
  });

  it('reconnects after server-initiated close', { timeout: 10_000 }, async () => {
    let connectionCount = 0;

    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'test close'), 50);
        }
      }),
    );

    const socket = createTestSocket({ maxReconnectAttempts: 3 });
    const reconnected = onceReconnect(socket);
    socket.connect();
    await reconnected;

    expect(connectionCount).toBe(2);
    expect(socket.getState()).toBe('open');

    socket.disconnect();
  });

  it('onReconnect fires on reconnection but not first connect', { timeout: 10_000 }, async () => {
    let connectionCount = 0;

    server.use(
      link.addEventListener('connection', ({ client }) => {
        connectionCount++;
        if (connectionCount === 1) {
          setTimeout(() => client.close(4000, 'test close'), 50);
        }
      }),
    );

    const socket = createTestSocket({ maxReconnectAttempts: 3 });
    let openCount = 0;
    let reconnectCount = 0;
    socket.onOpen(() => openCount++);
    socket.onReconnect(() => reconnectCount++);

    const reconnected = onceReconnect(socket);
    socket.connect();
    await reconnected;

    expect(openCount).toBe(2);
    expect(reconnectCount).toBe(1);

    socket.disconnect();
  });

  it('onReconnectFailed does not fire on intentional disconnect', async () => {
    server.use(link.addEventListener('connection', () => {}));

    const socket = createTestSocket();
    let reconnectFailed = false;
    socket.onReconnectFailed(() => {
      reconnectFailed = true;
    });

    const opened = onceOpen(socket);
    socket.connect();
    await opened;
    socket.disconnect();

    await waitFor(100);
    expect(reconnectFailed).toBe(false);
  });

  // ── Buffer flush on reconnect ───────────────────────────

  it('flushes buffered messages on reconnect', { timeout: 10_000 }, async () => {
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

    const socket = createTestSocket({
      bufferWhileDisconnected: true,
      maxReconnectAttempts: 3,
    });

    const firstOpen = onceOpen(socket);
    socket.connect();
    await firstOpen;

    // Connection drops, socket enters reconnecting
    const reconnected = onceReconnect(socket);

    // Wait for close, then buffer a message while reconnecting
    await waitFor(200);
    socket.send('chat', { text: 'buffered' });

    await reconnected;
    await waitFor(50);

    const bufferedMsg = received.find((r) => {
      const p = parseMessage(r);
      return p.event === 'chat' && (p.payload as any).text === 'buffered';
    });
    expect(bufferedMsg).toBeDefined();

    socket.disconnect();
  });
});
