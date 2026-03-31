/* oxlint-disable @typescript-eslint/no-explicit-any -- runtime test file */
import { Plugin } from '~/plugins/base.ts';
import { Socket } from '~/socket/socket.ts';
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
} from '~/test-helpers.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PluginHelpers } from '~/plugins/base.ts';
import type { TestContract } from '~/test-helpers.ts';

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

  // ── Middleware edge cases ─────────────────────────────────

  describe('Middleware edge cases', () => {
    it('middleware can modify the event name', async () => {
      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'ping', payload: { ts: 1 } }));
        }),
      );

      const socket = createTestSocket();
      socket.use((msg) => ({ event: 'pong', payload: msg.payload }));

      const pongMessages: unknown[] = [];
      const pingMessages: unknown[] = [];
      socket.on('pong' as any, (data: any) => pongMessages.push(data));
      socket.on('ping' as any, (data: any) => pingMessages.push(data));

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(50);

      expect(pongMessages).toEqual([{ ts: 1 }]);
      expect(pingMessages).toEqual([]);

      socket.disconnect();
    });

    it('chained middleware (multiple use() calls) composes modifications', async () => {
      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'greeting', payload: { text: 'hi' } }));
        }),
      );

      const socket = createTestSocket();
      socket.use((msg) => ({
        event: msg.event,
        payload: { ...(msg.payload as Record<string, unknown>), receivedAt: 100 },
      }));
      socket.use((msg) => ({
        event: msg.event,
        payload: { ...(msg.payload as Record<string, unknown>), processed: true },
      }));

      const messages: unknown[] = [];
      socket.on('greeting', (data) => messages.push(data));

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(50);

      expect(messages).toEqual([{ text: 'hi', receivedAt: 100, processed: true }]);

      socket.disconnect();
    });

    it('middleware returning undefined passes message through unchanged', async () => {
      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'greeting', payload: { text: 'pass-through' } }));
        }),
      );

      const socket = createTestSocket();
      socket.use(() => undefined);

      const messages: unknown[] = [];
      socket.on('greeting', (data) => messages.push(data));

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(50);

      expect(messages).toEqual([{ text: 'pass-through' }]);

      socket.disconnect();
    });
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

  // ── State machine edge cases ─────────────────────────────

  describe('State machine edge cases', () => {
    it('rapid connect/disconnect does not leave socket in inconsistent state', async () => {
      server.use(link.addEventListener('connection', () => {}));

      const socket = createTestSocket();
      socket.connect();
      socket.disconnect();

      expect(socket.getState()).toBe('closed');

      const opened = onceOpen(socket);
      socket.connect();
      await opened;

      expect(socket.getState()).toBe('open');

      socket.disconnect();
    });

    it('disconnect() during connecting state', async () => {
      server.use(link.addEventListener('connection', () => {}));

      const socket = createTestSocket();
      socket.connect();

      expect(socket.getState()).toBe('connecting');

      socket.disconnect();

      expect(socket.getState()).toBe('closed');
      expect(socket.ws).toBeNull();
    });

    it('getState() inside middleware returns open', async () => {
      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'greeting', payload: { text: 'hi' } }));
        }),
      );

      const socket = createTestSocket();
      let capturedState: string | undefined;
      socket.use(() => {
        capturedState = socket.getState();
      });

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(50);

      expect(capturedState).toBe('open');

      socket.disconnect();
    });

    it('getState() inside onClose callback reflects closed', async () => {
      server.use(link.addEventListener('connection', () => {}));

      const socket = createTestSocket();
      let capturedState: string | undefined;
      socket.onClose(() => {
        capturedState = socket.getState();
      });

      const opened = onceOpen(socket);
      socket.connect();
      await opened;

      socket.disconnect();

      expect(capturedState).toBe('closed');
    });
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

  // ── Error resilience ──────────────────────────────────────

  describe('Error resilience', () => {
    function swallowUncaught(): { errors: Error[]; cleanup: () => void } {
      const errors: Error[] = [];
      function handler(err: Error) {
        errors.push(err);
      }
      process.on('uncaughtException', handler);
      return { errors, cleanup: () => process.removeListener('uncaughtException', handler) };
    }

    it('middleware that throws does not crash the socket', async () => {
      const trap = swallowUncaught();
      let msgCount = 0;

      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'boom', payload: {} }));
          setTimeout(() => {
            client.send(JSON.stringify({ event: 'greeting', payload: { text: 'ok' } }));
          }, 50);
        }),
      );

      const socket = createTestSocket();
      socket.use((msg) => {
        if (msg.event === 'boom') throw new Error('middleware explosion');
        return undefined;
      });

      const messages: unknown[] = [];
      socket.on('greeting', (data) => {
        messages.push(data);
        msgCount++;
      });
      socket.on('boom' as any, () => {
        msgCount++;
      });

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(150);

      expect(msgCount).toBe(1);
      expect(messages).toEqual([{ text: 'ok' }]);
      expect(socket.getState()).toBe('open');
      expect(trap.errors.some((e) => e.message === 'middleware explosion')).toBe(true);

      socket.disconnect();
      trap.cleanup();
    });

    it('plugin onIncoming that throws does not crash subsequent messages', async () => {
      const trap = swallowUncaught();

      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(JSON.stringify({ event: 'explode', payload: {} }));
          setTimeout(() => {
            client.send(JSON.stringify({ event: 'greeting', payload: { text: 'safe' } }));
          }, 50);
        }),
      );

      class Exploder extends Plugin {
        id = 'exploder';
        override onIncoming(message: { event: string; payload: unknown }) {
          if (message.event === 'explode') throw new Error('plugin boom');
          return message;
        }
      }

      const exploder = new Exploder();
      exploder.helpers = {} as PluginHelpers;

      const socket = new Socket<TestContract>(WS_URL, { pingInterval: 0 } as any, [exploder]);

      const messages: unknown[] = [];
      socket.on('greeting', (data) => messages.push(data));
      socket.on('explode' as any, () => messages.push('should-not-appear'));

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(150);

      expect(messages).toEqual([{ text: 'safe' }]);
      expect(socket.getState()).toBe('open');
      expect(trap.errors.some((e) => e.message === 'plugin boom')).toBe(true);

      socket.disconnect();
      trap.cleanup();
    });

    it('onClose callback throwing prevents subsequent onClose callbacks', async () => {
      const trap = swallowUncaught();

      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.close(4001, 'test');
        }),
      );

      const socket = createTestSocket({ reconnect: false });

      const calls: string[] = [];
      socket.onClose(() => {
        calls.push('first');
        throw new Error('onClose explosion');
      });
      socket.onClose(() => {
        calls.push('second');
      });

      socket.connect();
      await waitFor(150);

      expect(calls).toEqual(['first']);
      expect(trap.errors.some((e) => e.message === 'onClose explosion')).toBe(true);

      trap.cleanup();
    });

    it('parseBinary returning object without payload field dispatches undefined', async () => {
      server.use(
        link.addEventListener('connection', ({ client }) => {
          client.send(new TextEncoder().encode('binary-data'));
        }),
      );

      const socket = createTestSocket({
        binaryType: 'arraybuffer',
        parseBinary: () => ({ event: 'binEvent' }) as any,
      });

      const messages: unknown[] = [];
      socket.on('binEvent' as any, (data: any) => messages.push(data));

      const opened = onceOpen(socket);
      socket.connect();
      await opened;
      await waitFor(50);

      expect(messages).toEqual([undefined]);

      socket.disconnect();
    });
  });
});
