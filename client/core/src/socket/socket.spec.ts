/* oxlint-disable @typescript-eslint/no-explicit-any -- runtime test file */
import { Socket } from '@/socket/socket.ts';
import {
  collectServerMessages,
  createTestSocket,
  getMswServer,
  link,
  onceClose,
  onceOpen,
  parseMessage,
  waitFor,
} from '@/test-helpers.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
});
