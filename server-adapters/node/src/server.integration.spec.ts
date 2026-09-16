import { createServer } from 'node:http';
import { connect } from 'node:net';
import { define, emits, t, translator } from '@wskit/server';
import { CloseCodes, RejectUpgrade } from '@wskit/server/errors';
import { scheduled } from '@wskit/server/scheduled';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ApiOf, KVProvider, Logger, ServerDefinition } from '@wskit/server/adapters';
import type { Server } from 'node:http';
import type { RawData } from 'ws';
import { binding } from './binding.ts';
import { setup } from './setup.ts';
import type { NodeAdmin } from './endpoint.ts';
import type { NodeServerEndpointOptions } from './setup.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

interface WireMessage {
  event: string;
  payload?: unknown;
}

interface IntegrationState {
  upgradeRequest?: Request;
  disconnect?: { code?: number; reason?: string };
  errors: string[];
  shutdowns: number;
}

interface TestService<TApi = unknown> {
  readonly server: Server;
  readonly ready: Promise<void>;
  admin(): Promise<TApi>;
  shutdownWSKit(): Promise<void>;
  shutdown(): Promise<void>;
}

function createTestService<THandler extends ServerDefinition>(
  handler: THandler,
  options: NodeServerEndpointOptions & { port: number },
): TestService<NodeAdmin<ApiOf<THandler>>> {
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const wskit = setup();
  const endpoint = wskit.bind(handler, options);
  httpServer.on('upgrade', endpoint.upgrade);
  let shutdown: Promise<void> | undefined;

  const ready = Promise.all([
    endpoint.ready(),
    new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.port, () => {
        httpServer.off('error', reject);
        resolve();
      });
    }),
  ]).then(() => {});

  return {
    server: httpServer,
    ready,
    admin: endpoint.admin,
    shutdownWSKit: wskit.shutdown,
    shutdown() {
      if (!shutdown) {
        shutdown = wskit.shutdown().then(
          () =>
            new Promise<void>((resolve, reject) => {
              httpServer.close((error) => (error ? reject(error) : resolve()));
            }),
        );
      }

      return shutdown;
    },
  };
}

function createHandler(state: IntegrationState) {
  const base = define({
    upgrade(request) {
      state.upgradeRequest = request;
      const url = new URL(request.url);
      if (url.pathname === '/reject') throw RejectUpgrade(401, 'No token');

      if (url.pathname === '/reject-socket') throw RejectUpgrade(4001, 'No token');

      if (url.pathname === '/reject-fractional') throw RejectUpgrade(4000.5, 'No token');

      if (url.pathname === '/reject-long-reason') {
        throw RejectUpgrade(CloseCodes.AUTH_INVALID, '🙂'.repeat(100));
      }

      return {
        userId: url.searchParams.get('user') ?? 'anonymous',
        meta: { role: request.headers.get('x-role') ?? 'guest' },
      };
    },
    capabilities: [
      emits({
        adminAnnouncement: t<{ text: string }>(),
        buffered: t<{ amount: number }>(),
        connected: t<{ role: string }>(),
        echoed: t<{ text: string }>(),
        scheduled: t<{ text: string }>(),
        scheduledQueued: t<{ ok: boolean }>(),
        stored: t<{ kv: string; sql: string }>(),
      }),
      scheduled({ 'integration-task': { data: t<{ text: string }>() } }),
    ],
  });

  base.onInit((ctx) => {
    ctx.sql.exec(
      'CREATE TABLE IF NOT EXISTS node_integration_values (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  });

  const echo = base.on('echo', {
    run(ctx, input) {
      const payload = input as { text: string };
      ctx.send('echoed', { text: payload.text });
    },
  });

  const store = base.on('store', {
    async run(ctx, input) {
      const value = String((input as { value: string }).value);
      ctx.sql.transaction((tx) => {
        tx.exec(
          'INSERT INTO node_integration_values (key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          'answer',
          value,
        );
      });
      await ctx.kv.set('answer', value);

      const row = ctx.sql
        .exec<{
          value: string;
        }>('SELECT value FROM node_integration_values WHERE key = ?', 'answer')
        .one();
      const kvValue = await ctx.kv.get('answer');
      ctx.send('stored', { sql: row?.value ?? '', kv: String(kvValue) });
    },
  });

  const schedule = base.on('schedule', {
    run(ctx) {
      ctx.schedule('integration-task', {
        time: Date.now() + 20,
        data: { text: 'from alarm' },
      });
      ctx.send('scheduledQueued', { ok: true });
    },
  });

  const buffered = base.on('buffered', {
    run(ctx) {
      ctx.send('buffered', { amount: ctx.bufferedAmount });
    },
  });

  const invalidClose = base.on('invalid-close', {
    run(ctx) {
      ctx.close(4000.5, 'do not expose this');
    },
  });

  base.scheduled('integration-task', {
    run(ctx, data) {
      ctx.broadcast('scheduled', { text: data.text });
    },
  });

  base.onConnect((ctx) => {
    ctx.send('connected', { role: ctx.meta.role });
  });

  base.onDisconnect((ctx) => {
    state.disconnect = { code: ctx.closeCode, reason: ctx.closeReason };
  });

  base.onError((_ctx, error) => {
    state.errors.push(error instanceof Error ? error.message : String(error));
  });

  base.onShutdown(() => {
    state.shutdowns += 1;
  });

  return base.assemble({
    handlers: [echo, store, schedule, buffered, invalidClose],
    api: (ctx) => ({
      announce(text: string): number {
        ctx.broadcast('adminAnnouncement', { text });
        return ctx.connectionCount;
      },
    }),
  });
}

function createTranslatedHandler(state: IntegrationState) {
  const base = define({
    translate: translator(() => ({
      inbound(raw) {
        const frame = JSON.parse(raw) as { data?: unknown; type?: string };
        if (frame.type === 'ignore') return null;

        return JSON.stringify({ event: frame.type, payload: frame.data });
      },
      outbound(raw) {
        const frame = JSON.parse(raw) as { event: string; payload?: unknown };
        return JSON.stringify({ type: frame.event, data: frame.payload });
      },
    })),
    upgrade(request) {
      state.upgradeRequest = request;
      return { userId: 'translator-user', meta: { role: 'translated' } };
    },
    capabilities: [
      emits({
        connected: t<{ role: string }>(),
        echoed: t<{ text: string }>(),
      }),
    ],
  });

  const echo = base.on('echo', {
    run(ctx, input) {
      ctx.send('echoed', { text: (input as { text: string }).text });
    },
  });

  base.onConnect((ctx) => {
    ctx.send('connected', { role: ctx.meta.role });
  });

  return base.assemble({ handlers: [echo] });
}

function serverPort(serverInstance: Server): number {
  const address = serverInstance.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');

  return address.port;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForJson<T>(socket: WebSocket): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<WireMessage> {
  return waitForJson<WireMessage>(socket);
}

function createMessageQueue(socket: WebSocket): {
  next(): Promise<WireMessage>;
  dispose(): void;
} {
  const messages: WireMessage[] = [];
  const waiters: Array<{
    resolve: (message: WireMessage) => void;
    reject: (error: unknown) => void;
  }> = [];

  function onMessage(data: RawData): void {
    try {
      const message = JSON.parse(data.toString()) as WireMessage;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    } catch (error) {
      const waiter = waiters.shift();
      if (waiter) waiter.reject(error);
    }
  }

  function onError(error: Error): void {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }

  socket.on('message', onMessage);
  socket.on('error', onError);

  return {
    next() {
      const message = messages.shift();
      if (message) return Promise.resolve(message);

      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    dispose() {
      socket.off('message', onMessage);
      socket.off('error', onError);
    },
  };
}

function expectNoMessage(socket: WebSocket, duration: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function onMessage(): void {
      clearTimeout(timer);
      socket.off('message', onMessage);
      reject(new Error('Unexpected WebSocket message'));
    }

    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, duration);
    socket.on('message', onMessage);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

function sendRawUpgrade(port: number, target: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(
        [
          `GET ${target} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

function sendOpenUpgrade(port: number, target: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    const timeout = setTimeout(() => finish(), 200);

    function finish(error?: Error): void {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    }

    socket.once('connect', () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
      finish();
    });
    socket.once('close', () => finish());
    socket.once('error', finish);
  });
}

function sendMalformedUpgrade(port: number, target: string): Promise<ReturnType<typeof connect>> {
  return new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: invalid',
          '',
          '',
        ].join('\r\n'),
      );
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function openPendingUpgrade(port: number, target: string): Promise<ReturnType<typeof connect>> {
  return new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function createFailingWebSocketServer(): {
  server: NodeWebSocketServer;
  attempts(): number;
} {
  let calls = 0;

  return {
    server: {
      handleUpgrade() {
        calls += 1;
        throw new Error('The client had already left');
      },
    },
    attempts: () => calls,
  };
}

function createObservedWebSocketServer(): {
  server: NodeWebSocketServer;
  enteredHandleUpgrade: Promise<void>;
} {
  const webSocketServer = new WebSocketServer({ noServer: true });
  let markHandleUpgrade!: () => void;
  const enteredHandleUpgrade = new Promise<void>((resolve) => {
    markHandleUpgrade = resolve;
  });
  const server: NodeWebSocketServer = {
    handleUpgrade(...args: Parameters<NodeWebSocketServer['handleUpgrade']>) {
      markHandleUpgrade();
      webSocketServer.handleUpgrade(...args);
    },
  };

  return { server, enteredHandleUpgrade };
}

function createCapturingWebSocketServer(): {
  server: NodeWebSocketServer;
  getAccepted(): WebSocket | undefined;
} {
  const webSocketServer = new WebSocketServer({ noServer: true });
  let accepted: WebSocket | undefined;
  const server: NodeWebSocketServer = {
    handleUpgrade(...args: Parameters<NodeWebSocketServer['handleUpgrade']>) {
      const [request, socket, head, callback] = args;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket, incomingRequest) => {
        accepted = webSocket;
        callback(webSocket, incomingRequest);
      });
    },
  };

  return { server, getAccepted: () => accepted };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

describe('Node server integration', () => {
  const services: TestService[] = [];
  const clients: WebSocket[] = [];
  const databases: Database.Database[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(closeClient));
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    for (const database of databases.splice(0)) database.close();
  });

  it('passes the complete upgrade request and routes real text frames through the engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), {
      port: 0,
      clientIp: { mode: 'direct' },
    });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat?user=alice`, {
      headers: { Cookie: 'session=abc', 'x-role': 'member' },
    });
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);

    await expect(connected).resolves.toMatchObject({
      event: 'connected',
      payload: { role: 'member' },
    });

    socket.send(JSON.stringify({ event: 'echo', payload: { text: 'hello' } }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'echoed',
      payload: { text: 'hello' },
    });

    expect(state.upgradeRequest?.url).toBe(
      `http://127.0.0.1:${serverPort(service.server)}/chat?user=alice`,
    );
    expect(state.upgradeRequest?.method).toBe('GET');
    expect(state.upgradeRequest?.headers.get('cookie')).toBe('session=abc');
    expect(state.upgradeRequest?.headers.get('x-role')).toBe('member');
    expect(state.upgradeRequest?.headers.get('WSKit-Client-IP')).toMatch(
      /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/,
    );

    expect(state.upgradeRequest?.signal).toBeInstanceOf(AbortSignal);
  });

  it('derives the client IP from a trusted proxy during a real upgrade', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), {
      port: 0,
      clientIp: { mode: 'proxy', trustedProxies: ['127.0.0.1', '::1'] },
    });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    expect(state.upgradeRequest?.headers.get('WSKit-Client-IP')).toBe('203.0.113.7');
  });

  it('rejects a real upgrade with an HTTP response', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject`);
    clients.push(socket);

    await expect(waitForOpen(socket)).rejects.toThrow();
    expect(state.upgradeRequest).toBeDefined();
  });

  it('turns an invalid upgrade close code into a safe HTTP rejection', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const response = await sendRawUpgrade(serverPort(service.server), '/reject-fractional');

    expect(response).toContain('HTTP/1.1 403 Forbidden');
    expect(response).toContain('Upgrade rejected');
  });

  it('rejects a real upgrade with a WebSocket close decision', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject-socket`);
    clients.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('rejects an authority-changing request target over the real HTTP boundary', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const response = await sendRawUpgrade(serverPort(service.server), '/\\evil.example/chat');

    expect(response).toContain('HTTP/1.1 400 Bad Request');
  });

  it('does not retain a malformed upgrade while shutting down', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const observed = createObservedWebSocketServer();
    const service = createTestService(createHandler(state), {
      port: 0,
      webSocketServer: observed.server,
    });
    services.push(service);
    await service.ready;

    const malformedSocket = await sendMalformedUpgrade(serverPort(service.server), '/chat');
    try {
      await observed.enteredHandleUpgrade;
      await expect(service.shutdown()).resolves.toBeUndefined();
    } finally {
      malformedSocket.destroy();
    }
  });

  it('limits an oversized WebSocket close reason over the real transport', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject-long-reason`);
    clients.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({
      code: CloseCodes.AUTH_INVALID,
      reason: '🙂'.repeat(30),
    });
  });

  it('turns an invalid application close code into a safe WebSocket close', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);

    await connected;

    socket.send(JSON.stringify({ event: 'invalid-close', payload: {} }));

    await expect(closed).resolves.toEqual({ code: 1011, reason: 'Internal error' });
  });

  it('rejects binary frames through the real bridge', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const closed = waitForClose(socket);
    socket.send(Buffer.from('binary'));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: '[wskit] binary frames are not supported yet',
    });
    await vi.waitFor(() =>
      expect(state.disconnect).toEqual({
        code: 1003,
        reason: '[wskit] binary frames are not supported yet',
      }),
    );
  });

  it('forwards a client close through the real engine lifecycle', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const closed = waitForClose(socket);
    socket.close(4000, 'client bye');

    await expect(closed).resolves.toEqual({ code: 4000, reason: 'client bye' });
    await vi.waitFor(() => expect(state.disconnect).toEqual({ code: 4000, reason: 'client bye' }));
  });

  it('forwards a real WebSocket transport error through the engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const captured = createCapturingWebSocketServer();
    const service = createTestService(createHandler(state), {
      port: 0,
      webSocketServer: captured.server,
    });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    await vi.waitFor(() => expect(captured.getAccepted()).toBeDefined());
    const transportError = new Error('transport failed');
    captured.getAccepted()!.emit('error', transportError);

    await vi.waitFor(() => expect(state.errors).toEqual(['transport failed']));
  });

  it('runs SQL, KV, and scheduled work through real handlers', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify({ event: 'store', payload: { value: 'persisted' } }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'stored',
      payload: { sql: 'persisted', kv: 'persisted' },
    });

    const messages = createMessageQueue(socket);
    try {
      socket.send(JSON.stringify({ event: 'schedule', payload: {} }));
      await expect(messages.next()).resolves.toMatchObject({
        event: 'scheduledQueued',
        payload: { ok: true },
      });
      await expect(messages.next()).resolves.toMatchObject({
        event: 'scheduled',
        payload: { text: 'from alarm' },
      });
    } finally {
      messages.dispose();
    }
  });

  it('lets a custom host prepare and attach a peer through the public binding seam', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const node = binding();
    const endpoint = node.bind(createHandler(state), {});
    await endpoint.ready();

    const upgrade = await endpoint.prepare(
      new Request('https://example.test/chat', { headers: { 'WSKit-Client-IP': 'spoofed' } }),
      { clientIp: '203.0.113.7' },
    );
    expect(upgrade.type).toBe('accept');
    if (upgrade.type !== 'accept') throw new Error('Expected an accepted upgrade');

    const transport = {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: () => 0,
      backpressureSupported: true,
    };

    const connection = upgrade.accept(transport);
    await connection.message(JSON.stringify({ event: 'echo', payload: { text: 'custom host' } }));

    await vi.waitFor(() =>
      expect(transport.send).toHaveBeenCalledWith(expect.stringContaining('custom host')),
    );
    expect(state.upgradeRequest?.headers.get('WSKit-Client-IP')).toBe('203.0.113.7');
    await node.shutdown();
  });

  it('uses injected KV and logger configuration through a real WebSocket endpoint', async () => {
    const values = new Map<string, unknown>();
    const kv: KVProvider = {
      get: vi.fn(async (key) => values.get(key)),
      set: vi.fn(async (key, value) => void values.set(key, value)),
      delete: vi.fn(async (key) => void values.delete(key)),
      list: vi.fn(async () => [...values.keys()]),
    };

    const logger = createMockLogger();
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0, kv, logger });

    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify({ event: 'store', payload: { value: 'injected' } }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'stored',
      payload: { sql: 'injected', kv: 'injected' },
    });
    expect(kv.set).toHaveBeenCalledWith('answer', 'injected', undefined);

    socket.send('not json');
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('Invalid JSON message dropped'),
    );
  });

  it('exposes the live Node buffer amount through the engine context', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify({ event: 'buffered', payload: {} }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'buffered',
      payload: { amount: expect.any(Number) },
    });
  });

  it('runs custom admin API methods through the real engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const announcement = waitForMessage(socket);
    expect((await service.admin()).announce('from admin')).toBe(1);
    await expect(announcement).resolves.toMatchObject({
      event: 'adminAnnouncement',
      payload: { text: 'from admin' },
    });
  });

  it('reconciles stale persisted connections when a new Node service starts', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const firstState: IntegrationState = { errors: [], shutdowns: 0 };
    const first = createTestService(createHandler(firstState), {
      port: 0,
      sql: database,
    });
    services.push(first);

    await first.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(first.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    expect((await first.admin()).connectionCount).toBe(1);

    const secondState: IntegrationState = { errors: [], shutdowns: 0 };
    const second = createTestService(createHandler(secondState), {
      port: 0,
      sql: database,
    });
    services.push(second);
    await second.ready;

    expect((await second.admin()).connectionCount).toBe(0);
  });

  it('translates inbound and outbound frames through the real engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createTranslatedHandler(state), {
      port: 0,
    });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForJson<{ data: { role: string }; type: string }>(socket);
    await waitForOpen(socket);
    await expect(connected).resolves.toEqual({
      type: 'connected',
      data: { role: 'translated' },
    });

    socket.send(JSON.stringify({ type: 'ignore', data: {} }));
    await expectNoMessage(socket, 20);

    socket.send(JSON.stringify({ type: 'echo', data: { text: 'translated' } }));
    await expect(waitForJson(socket)).resolves.toEqual({
      type: 'echoed',
      data: { text: 'translated' },
    });
  });

  it('closes a connected real client with going-away during shutdown', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const closed = waitForClose(socket);
    await service.shutdown();

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(state.disconnect).toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(state.shutdowns).toBe(1);
  });

  it('lets the application decide when to shut down its server', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const closed = waitForClose(socket);
    await service.shutdown();

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    await service.shutdown();
    expect(state.shutdowns).toBe(1);
  });

  it('drops upgrades that arrive after WSKit shutdown starts', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    await service.shutdownWSKit();

    await expect(sendOpenUpgrade(serverPort(service.server), '/chat')).resolves.toBe('');
  });

  it('does not hand a reset socket to the WebSocket host after upgrade preparation', async () => {
    let started!: () => void;
    let finished = false;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handler = define({
      async upgrade(request) {
        started();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve()),
        );
        finished = true;
        return { userId: 'left' };
      },
    }).assemble({ handlers: [] });
    const webSocketServer = createFailingWebSocketServer();

    const service = createTestService(handler, {
      port: 0,
      webSocketServer: webSocketServer.server,
    });
    services.push(service);
    await service.ready;

    const socket = await openPendingUpgrade(serverPort(service.server), '/chat');
    socket.on('error', () => {});
    await startedUpgrade;
    socket.resetAndDestroy();

    await vi.waitFor(() => expect(finished).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(webSocketServer.attempts()).toBe(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  it('cancels a pending upgrade when the client half-closes its socket', async () => {
    let started!: () => void;
    let aborted = false;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handler = define({
      async upgrade(request) {
        started();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        return { userId: 'left' };
      },
    }).assemble({ handlers: [] });
    const webSocketServer = createFailingWebSocketServer();

    const service = createTestService(handler, {
      port: 0,
      webSocketServer: webSocketServer.server,
    });
    services.push(service);
    await service.ready;

    const socket = await openPendingUpgrade(serverPort(service.server), '/chat');
    socket.on('error', () => {});
    await startedUpgrade;
    socket.end();

    await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 100 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(webSocketServer.attempts()).toBe(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
