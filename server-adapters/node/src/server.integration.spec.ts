import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, server as createServerDefinition, emits, t } from '@livething/server';
import { channels } from '@livething/server/channels';
import { CloseCodes, RejectAuth } from '@livething/server/errors';
import { scheduled } from '@livething/server/scheduled';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { KVProvider, Logger, ServerDefinition } from '@livething/server/adapters';
import type { Server } from 'node:http';
import type { RawData } from 'ws';
import { binding } from './binding.ts';
import { setup } from './setup.ts';
import {
  capturedBridges,
  isConnectedFrame,
  nextJsonMessage,
  nextRawMessage,
} from './test-utils.ts';
import type { NodeAdmin } from './endpoint.ts';
import type { NodeServerEndpointOptions } from './setup.ts';
import type { NodeWebSocketServer } from './upgrade.ts';

vi.mock('./socket.ts', async (importOriginal) => {
  const { captureBridges } = await import('./test-utils.ts');
  return captureBridges(await importOriginal());
});

type WireFrame = readonly [event: string, payload: unknown, metadata: null];

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
  shutdownLiveThing(): Promise<void>;
  shutdown(): Promise<void>;
}

function createTestService<TDefinition extends ServerDefinition>(
  definition: TDefinition,
  options: NodeServerEndpointOptions & { port: number },
): TestService<NodeAdmin<TDefinition>> {
  const httpServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const livething = setup();
  const endpoint = livething.bind(definition, options);
  httpServer.on('upgrade', endpoint.upgrade);
  let shutdown: Promise<void> | undefined;

  const ready = Promise.all([
    endpoint.ready(),
    new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.port, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    }),
  ]).then(() => {});

  return {
    server: httpServer,
    ready,
    admin: endpoint.admin,
    shutdownLiveThing: livething.shutdown,
    shutdown() {
      if (!shutdown) {
        shutdown = livething.shutdown().then(
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

function buildServerDefinition(state: IntegrationState) {
  const base = createServerDefinition({
    authenticate(request) {
      state.upgradeRequest = request;
      const url = new URL(request.url);
      if (url.pathname === '/reject') throw RejectAuth(401, 'No token');

      if (url.pathname === '/reject-socket') throw RejectAuth(4001, 'No token');

      if (url.pathname === '/reject-fractional') throw RejectAuth(4000.5, 'No token');

      if (url.pathname === '/reject-long-reason') {
        throw RejectAuth(CloseCodes.AUTH_INVALID, '🙂'.repeat(100));
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
    onInit(ctx) {
      ctx.sql.exec(
        'CREATE TABLE IF NOT EXISTS node_integration_values (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
    },
    onConnect(ctx) {
      ctx.send('connected', { role: ctx.meta.role });
    },
    onDisconnect(ctx) {
      state.disconnect = { code: ctx.closeCode, reason: ctx.closeReason };
    },
    onError(_ctx, error) {
      state.errors.push(error instanceof Error ? error.message : String(error));
    },
    onShutdown() {
      state.shutdowns += 1;
    },
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
      ctx.sql.transaction(() => {
        ctx.sql.exec(
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

  const integrationTask = base.scheduled('integration-task', {
    run(ctx, data) {
      ctx.broadcast('scheduled', { text: data.text });
    },
  });

  return base.assemble({
    handlers: [echo, store, schedule, buffered, invalidClose, integrationTask],
    api: (ctx) => ({
      announce(text: string): number {
        ctx.broadcast('adminAnnouncement', { text });
        return ctx.connectionCount;
      },
    }),
  });
}

function buildContextDefinition() {
  const base = createServerDefinition({
    authenticate(request, ctx) {
      const user = new URL(request.url).searchParams.get('user') ?? 'anonymous';
      const row = ctx.sql
        .exec<{ role: string }>('SELECT role FROM context_roles WHERE user = ?', user)
        .one();

      return { userId: user, meta: { role: row?.role ?? 'guest' } };
    },
    capabilities: [emits({ whoami: t<{ user: string; role: string }>() })],
    onInit(ctx) {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS context_roles (user TEXT PRIMARY KEY, role TEXT)');
      ctx.sql.exec("INSERT OR REPLACE INTO context_roles VALUES ('alice', 'admin')");
    },
  });

  function describeCaller() {
    const ctx = context.connection(base);
    return { user: ctx.user.id, role: ctx.meta.role };
  }

  const whoami = base.on('whoami', {
    async run(ctx) {
      await Promise.resolve();
      ctx.send('whoami', describeCaller());
    },
  });

  return base.assemble({ handlers: [whoami] });
}

// What @livething/client offers for a token, built with Node's own base64url.
function tokenSubprotocols(token: string, protocols: string[] | undefined): string[] {
  const encoded = Buffer.from(token, 'utf8').toString('base64url');

  return [...(protocols ?? ['livething-v1']), `livething-v1.token.${encoded}`];
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
  return nextJsonMessage<T>(socket);
}

function waitForMessage(socket: WebSocket): Promise<WireFrame> {
  return waitForJson<WireFrame>(socket);
}

function createMessageQueue(socket: WebSocket): {
  next(): Promise<WireFrame>;
  dispose(): void;
} {
  const messages: WireFrame[] = [];
  const waiters: Array<{
    resolve: (message: WireFrame) => void;
    reject: (error: unknown) => void;
  }> = [];

  function onMessage(data: RawData, isBinary: boolean): void {
    if (isConnectedFrame(data, isBinary)) return;

    try {
      const message = JSON.parse(data.toString()) as WireFrame;
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

function sendNonWebSocketUpgrade(port: number, target: string): Promise<string> {
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
          'Upgrade: h2c',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('close', () => resolve(response));
    socket.once('error', reject);
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
    const service = createTestService(buildServerDefinition(state), {
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

    await expect(connected).resolves.toEqual(['connected', { role: 'member' }, null]);

    socket.send(JSON.stringify(['echo', { text: 'hello' }, null]));
    await expect(waitForMessage(socket)).resolves.toEqual(['echoed', { text: 'hello' }, null]);

    expect(state.upgradeRequest?.url).toBe(
      `http://127.0.0.1:${serverPort(service.server)}/chat?user=alice`,
    );
    expect(state.upgradeRequest?.method).toBe('GET');
    expect(state.upgradeRequest?.headers.get('cookie')).toBe('session=abc');
    expect(state.upgradeRequest?.headers.get('x-role')).toBe('member');
    expect(state.upgradeRequest?.headers.get('LiveThing-Client-IP')).toMatch(
      /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/,
    );

    expect(state.upgradeRequest?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets upgrade read storage and a helper read ctx through context.connection', async () => {
    const service = createTestService(buildContextDefinition(), { port: 0 });
    services.push(service);
    await service.ready;

    for (const [user, role] of [
      ['alice', 'admin'],
      ['bob', 'guest'],
    ] as const) {
      const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/?user=${user}`);
      clients.push(socket);
      await waitForOpen(socket);
      const reply = waitForMessage(socket);
      socket.send(JSON.stringify(['whoami', {}, null]));

      await expect(reply).resolves.toEqual(['whoami', { user, role }, null]);
    }
  });

  it('derives the client IP from a trusted proxy during a real upgrade', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), {
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

    expect(state.upgradeRequest?.headers.get('LiveThing-Client-IP')).toBe('203.0.113.7');
  });

  it('rejects a real upgrade with an HTTP response', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject`);
    clients.push(socket);

    await expect(waitForOpen(socket)).rejects.toThrow();
    expect(state.upgradeRequest).toBeDefined();
  });

  it('turns an invalid upgrade close code into a safe HTTP rejection', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const response = await sendRawUpgrade(serverPort(service.server), '/reject-fractional');

    expect(response).toContain('HTTP/1.1 403 Forbidden');
    expect(response).toContain('Authentication rejected');
  });

  it('answers a non-WebSocket upgrade with 400 without running upgrade', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const response = await sendNonWebSocketUpgrade(serverPort(service.server), '/chat');

    expect(response).toContain('HTTP/1.1 400 Bad Request');
    expect(state.upgradeRequest).toBeUndefined();
  });

  it('rejects a real upgrade with a WebSocket close decision', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject-socket`);
    clients.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  describe('the token subprotocol', () => {
    async function startService(state: IntegrationState) {
      const service = createTestService(buildServerDefinition(state), { port: 0 });
      services.push(service);
      await service.ready;

      return `ws://127.0.0.1:${serverPort(service.server)}`;
    }

    it('reaches authenticate as Authorization, and the answer is the first offered name', async () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      const base = await startService(state);
      const token = 'x'.repeat(11_625);

      const socket = new WebSocket(`${base}/chat`, tokenSubprotocols(token, undefined));
      clients.push(socket);
      await waitForOpen(socket);

      expect(socket.protocol).toBe('livething-v1');
      expect(state.upgradeRequest?.headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(state.upgradeRequest?.headers.get('sec-websocket-protocol')).toBe('livething-v1');
    });

    it("answers with the app's own name when it offers one", async () => {
      const base = await startService({ errors: [], shutdowns: 0 });

      const socket = new WebSocket(`${base}/chat`, tokenSubprotocols('t', ['huddle.v2']));
      clients.push(socket);
      await waitForOpen(socket);

      expect(socket.protocol).toBe('huddle.v2');
    });

    it('answers a socket rejected by close code with the first offered name', async () => {
      const base = await startService({ errors: [], shutdowns: 0 });

      const socket = new WebSocket(`${base}/reject-socket`, tokenSubprotocols('t', undefined));
      clients.push(socket);
      const closed = waitForClose(socket);
      await waitForOpen(socket);

      expect(socket.protocol).toBe('livething-v1');
      await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
    });

    it('fails a handshake whose headers are too large with 431', async () => {
      const base = await startService({ errors: [], shutdowns: 0 });

      const socket = new WebSocket(
        `${base}/chat`,
        tokenSubprotocols('x'.repeat(13_000), undefined),
      );
      const status = await new Promise<number | undefined>((resolve) => {
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
        socket.once('error', () => resolve(undefined));
      });

      expect(status).toBe(431);
    });
  });

  it('rejects an authority-changing request target over the real HTTP boundary', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const response = await sendRawUpgrade(serverPort(service.server), '/\\evil.example/chat');

    expect(response).toContain('HTTP/1.1 400 Bad Request');
  });

  it('does not retain a malformed upgrade while shutting down', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const observed = createObservedWebSocketServer();
    const service = createTestService(buildServerDefinition(state), {
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
    const service = createTestService(buildServerDefinition(state), { port: 0 });
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
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);

    await connected;

    socket.send(JSON.stringify(['invalid-close', {}, null]));

    await expect(closed).resolves.toEqual({ code: 1011, reason: 'Internal error' });
  });

  describe('maxMessageBytes', () => {
    async function connectTo(options: NodeServerEndpointOptions) {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      const service = createTestService(buildServerDefinition(state), { port: 0, ...options });
      services.push(service);
      await service.ready;

      const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
      clients.push(socket);
      const connected = waitForMessage(socket);
      await waitForOpen(socket);
      await connected;

      return socket;
    }

    it('refuses a value that ws cannot hold, naming the option', () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      for (const maxMessageBytes of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
        expect(() => setup().bind(buildServerDefinition(state), { maxMessageBytes })).toThrow(
          /The endpoint maxMessageBytes must be a whole number of bytes from 1 to 2147483647/,
        );
      }
    });

    it('refuses a bad option before it opens the database', () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      const directory = mkdtempSync(join(tmpdir(), 'livething-limits-'));
      const sql = join(directory, 'huddle.sqlite');
      try {
        expect(() =>
          binding().bind(buildServerDefinition(state), { sql, maxMessageBytes: 0 }),
        ).toThrow(/maxMessageBytes/);
        expect(() =>
          binding().bind(buildServerDefinition(state), {
            sql,
            clientIp: { mode: 'proxy', trustedProxies: [] },
          }),
        ).toThrow(/trustedProxies/);
        expect(existsSync(sql)).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('closes the socket with 1009 for a message over the limit', async () => {
      const socket = await connectTo({ maxMessageBytes: 1024 });

      const closed = waitForClose(socket);
      socket.send('x'.repeat(2000));

      expect((await closed).code).toBe(CloseCodes.MESSAGE_TOO_BIG);
    });

    it('still holds when the app passes its own WebSocket server without a limit', async () => {
      const socket = await connectTo({
        maxMessageBytes: 1024,
        webSocketServer: new WebSocketServer({ noServer: true }),
      });

      const closed = waitForClose(socket);
      socket.send('x'.repeat(2000));

      expect(await closed).toEqual({
        code: CloseCodes.MESSAGE_TOO_BIG,
        reason: 'Message is too big',
      });
    });

    it('closes the socket with 1009 for a binary message over the limit', async () => {
      const socket = await connectTo({
        maxMessageBytes: 1024,
        webSocketServer: new WebSocketServer({ noServer: true }),
      });

      const closed = waitForClose(socket);
      socket.send(new Uint8Array(2000));

      expect(await closed).toEqual({
        code: CloseCodes.MESSAGE_TOO_BIG,
        reason: 'Message is too big',
      });
    });

    it('defaults to 32 MiB', async () => {
      const socket = await connectTo({});

      const closed = waitForClose(socket);
      socket.send('x'.repeat(32 * 1024 * 1024 + 1));

      expect((await closed).code).toBe(CloseCodes.MESSAGE_TOO_BIG);
    });
  });

  describe('compression', () => {
    async function connectTo(options: NodeServerEndpointOptions) {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      const service = createTestService(buildServerDefinition(state), { port: 0, ...options });
      services.push(service);
      await service.ready;

      // A ws client offers permessage-deflate by default, like browsers do.
      const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
      clients.push(socket);
      const connected = waitForMessage(socket);
      await waitForOpen(socket);
      await connected;

      return socket;
    }

    async function wireBytesOf(socket: WebSocket, text: string): Promise<number> {
      const tcp = (socket as WebSocket & { _socket: { bytesRead: number } })._socket;
      const before = tcp.bytesRead;
      const received = nextRawMessage(socket);
      capturedBridges.at(-1)!.transport.send({ kind: 'text', text });
      await received;

      return tcp.bytesRead - before;
    }

    it('is off by default, so the extension is not negotiated', async () => {
      const socket = await connectTo({});

      expect(socket.extensions).toBe('');
      expect(await wireBytesOf(socket, 'x'.repeat(2000))).toBeGreaterThan(2000);
    });

    it('negotiates permessage-deflate, and JSON and binary messages still round-trip', async () => {
      const socket = await connectTo({ compression: true });

      expect(socket.extensions).toBe('permessage-deflate');

      const text = 'a new message in #general '.repeat(100);
      socket.send(JSON.stringify(['echo', { text }, null]));
      await expect(waitForMessage(socket)).resolves.toEqual(['echoed', { text }, null]);
      expect(await wireBytesOf(socket, 'x'.repeat(2000))).toBeLessThan(200);

      const bridge = capturedBridges.at(-1)!;
      const outgoing = nextRawMessage(socket);
      bridge.transport.send({ kind: 'bytes', bytes: new Uint8Array(4096).fill(7) });
      const { data, isBinary } = await outgoing;
      expect(isBinary).toBe(true);

      expect([...(data as Buffer)]).toEqual(Array.from({ length: 4096 }, () => 7));

      const closed = waitForClose(socket);
      socket.send(new Uint8Array(4096).fill(9));
      await closed;
      expect([...bridge.binaryMessages[0]!]).toEqual(Array.from({ length: 4096 }, () => 9));
    });

    it('passes threshold to ws, so a smaller message goes out as it is', async () => {
      const socket = await connectTo({ compression: { threshold: 4096 } });

      expect(socket.extensions).toContain('permessage-deflate');
      expect(await wireBytesOf(socket, 'x'.repeat(2000))).toBeGreaterThan(2000);
      expect(await wireBytesOf(socket, 'x'.repeat(5000))).toBeLessThan(200);
    });

    it('refuses a value that is not true, false or { threshold }', () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      for (const compression of ['yes', 1, null]) {
        expect(() =>
          setup().bind(buildServerDefinition(state), {
            compression: compression as unknown as boolean,
          }),
        ).toThrow(/\[livething\] The endpoint compression must be true, false or \{ threshold \}/);
      }

      for (const threshold of [-1, 1.5, Number.NaN, '1024']) {
        expect(() =>
          setup().bind(buildServerDefinition(state), {
            compression: { threshold: threshold as number },
          }),
        ).toThrow(
          /\[livething\] The endpoint compression\.threshold must be a whole number of bytes from 0/,
        );
      }
    });

    it('refuses compression together with your own WebSocket server', () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };

      expect(() =>
        setup().bind(buildServerDefinition(state), {
          compression: true,
          webSocketServer: new WebSocketServer({ noServer: true }),
        }),
      ).toThrow(
        /\[livething\] bind\(\) got both webSocketServer and compression\. Set perMessageDeflate on your own WebSocketServer instead\./,
      );
    });
  });

  describe('binary messages', () => {
    async function connectTo(state: IntegrationState) {
      const service = createTestService(buildServerDefinition(state), { port: 0 });
      services.push(service);
      await service.ready;

      const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
      clients.push(socket);
      const connected = waitForMessage(socket);
      await waitForOpen(socket);
      await connected;

      return socket;
    }

    it('reach the engine as a plain Uint8Array, which closes the socket with 1003', async () => {
      const state: IntegrationState = { errors: [], shutdowns: 0 };
      const socket = await connectTo(state);

      const closed = waitForClose(socket);
      // ws hands the server a small frame as a view into a bigger shared buffer.
      socket.send(Buffer.from([1, 2, 3]));

      await expect(closed).resolves.toEqual({
        code: 1003,
        reason: '[livething] this server does not use binary()',
      });
      const [received] = capturedBridges.at(-1)!.binaryMessages;
      expect(Object.getPrototypeOf(received)).toBe(Uint8Array.prototype);
      expect([...received!]).toEqual([1, 2, 3]);
      await vi.waitFor(() => expect(state.disconnect?.code).toBe(1003));
    });

    it('go out from a bytes frame, and text frames still go out as text', async () => {
      const socket = await connectTo({ errors: [], shutdowns: 0 });
      const { transport } = capturedBridges.at(-1)!;

      const binary = nextRawMessage(socket);
      transport.send({ kind: 'bytes', bytes: new Uint8Array([7, 8, 9]) });
      const { data, isBinary } = await binary;
      const text = nextRawMessage(socket);
      transport.send({ kind: 'text', text: 'pong' });

      expect(isBinary).toBe(true);
      expect([...(data as Buffer)]).toEqual([7, 8, 9]);
      await expect(text).resolves.toMatchObject({ isBinary: false });
    });
  });

  it('drops a client that stops reading about one second after its 1013 close, not 30 seconds', async () => {
    // The handler moves the clock that the slow-member check reads, so the 10-second grace
    // passes at once. Sockets and timers stay real, and the test measures with the real clock.
    const realNow = performance.now.bind(performance);
    let skew = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skew);

    let refused!: (at: number) => void;
    let disconnected!: (at: number) => void;
    const refusedAt = new Promise<number>((resolve) => (refused = resolve));
    const disconnectedAt = new Promise<number>((resolve) => (disconnected = resolve));

    const base = createServerDefinition({
      authenticate: () => ({ userId: 'kofi' }),
      capabilities: [emits({ 'history-page': t<{ text: string }>() })],
      onDisconnect() {
        disconnected(realNow());
      },
    });
    const handleLoadHistory = base.on('load-history', {
      async run(ctx) {
        // Each turn writes a burst. Once the kernel buffer is full, `ws` holds the rest, and
        // the 1013 close comes when that stays over the limit for longer than the grace.
        for (let turn = 0; turn < 5000; turn += 1) {
          for (let page = 0; page < 64; page += 1) {
            if (!ctx.send('history-page', { text: 'x'.repeat(900) })) {
              refused(realNow());
              return;
            }
          }

          skew += 1000;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
    });
    const service = createTestService(base.assemble({ handlers: [handleLoadHistory] }), {
      port: 0,
      maxMessageBytes: 1024,
    });

    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    try {
      await waitForOpen(socket);
      socket.send(JSON.stringify(['load-history', null, null]));
      (socket as WebSocket & { _socket: { pause(): void } })._socket.pause();

      const [refusedTime, disconnectedTime] = await Promise.all([refusedAt, disconnectedAt]);

      expect(disconnectedTime - refusedTime).toBeLessThan(3000);
    } finally {
      nowSpy.mockRestore();
      socket.terminate();
    }
  }, 40_000);

  it('forwards a client close through the real engine lifecycle', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
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
    const service = createTestService(buildServerDefinition(state), {
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

  it('reports a send to a closing socket as not delivered', async () => {
    let releaseReply!: () => void;
    const replyAllowed = new Promise<void>((resolve) => (releaseReply = resolve));
    const sent: boolean[] = [];

    const base = createServerDefinition({
      authenticate: () => ({ userId: 'alice' }),
      capabilities: [emits({ answer: t<{ text: string }>() })],
    });
    const handleAsk = base.on('ask', {
      async run(ctx) {
        await replyAllowed;
        sent.push(ctx.send('answer', { text: 'late' }));
      },
    });

    const captured = createCapturingWebSocketServer();
    const service = createTestService(base.assemble({ handlers: [handleAsk] }), {
      port: 0,
      webSocketServer: captured.server,
    });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    await waitForOpen(socket);
    await vi.waitFor(() => expect(captured.getAccepted()).toBeDefined());

    socket.send(JSON.stringify(['ask', {}, null]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The socket is closing, but its close event has not reached LiveThing yet.
    captured.getAccepted()!.terminate();
    releaseReply();

    await vi.waitFor(() => expect(sent).toEqual([false]));
  });

  it('runs SQL, KV, and scheduled work through real handlers', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify(['store', { value: 'persisted' }, null]));
    await expect(waitForMessage(socket)).resolves.toEqual([
      'stored',
      { sql: 'persisted', kv: 'persisted' },
      null,
    ]);

    const messages = createMessageQueue(socket);
    try {
      socket.send(JSON.stringify(['schedule', {}, null]));
      await expect(messages.next()).resolves.toEqual(['scheduledQueued', { ok: true }, null]);
      await expect(messages.next()).resolves.toEqual(['scheduled', { text: 'from alarm' }, null]);
    } finally {
      messages.dispose();
    }
  });

  it('lets a custom host prepare and attach a peer through the public binding seam', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const node = binding();
    const endpoint = node.bind(buildServerDefinition(state), {});
    await endpoint.ready();

    const upgrade = await endpoint.prepare(
      new Request('https://example.test/chat', { headers: { 'LiveThing-Client-IP': 'spoofed' } }),
      { clientIp: '203.0.113.7' },
    );
    expect(upgrade.type).toBe('accept');
    if (upgrade.type !== 'accept') throw new Error('Expected an accepted upgrade');

    const transport = {
      sent: [] as string[],
      send({ text }: { kind: 'text'; text: string }) {
        this.sent.push(text);
      },
      close() {},
      bufferedAmount: () => 0,
      backpressureSupported: true,
    };

    const connection = upgrade.accept(transport);
    await connection.message(JSON.stringify(['echo', { text: 'custom host' }, null]));

    await vi.waitFor(() => expect(transport.sent.join()).toContain('custom host'));
    expect(state.upgradeRequest?.headers.get('LiveThing-Client-IP')).toBe('203.0.113.7');
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
    const service = createTestService(buildServerDefinition(state), { port: 0, kv, logger });

    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify(['store', { value: 'injected' }, null]));
    await expect(waitForMessage(socket)).resolves.toEqual([
      'stored',
      { sql: 'injected', kv: 'injected' },
      null,
    ]);
    expect(kv.set).toHaveBeenCalledWith('answer', 'injected', undefined);

    socket.send('not json');
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('Invalid JSON message dropped'),
    );
  });

  it('exposes the live Node buffer amount through the engine context', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    socket.send(JSON.stringify(['buffered', {}, null]));
    await expect(waitForMessage(socket)).resolves.toEqual([
      'buffered',
      { amount: expect.any(Number) },
      null,
    ]);
  });

  it('runs custom admin API methods through the real engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const announcement = waitForMessage(socket);
    expect((await service.admin()).announce('from admin')).toBe(1);
    await expect(announcement).resolves.toEqual([
      'adminAnnouncement',
      { text: 'from admin' },
      null,
    ]);
  });

  it("admin channels.broadcast reaches only that channel's members", async () => {
    const base = createServerDefinition({
      authenticate: (request) => ({
        userId: new URL(request.url).searchParams.get('user') ?? 'anonymous',
        meta: {},
      }),
      capabilities: [channels(), emits({ done: t<{}>() })],
    });
    const general = base.channel('general', {
      capabilities: [emits({ huddleClosing: t<{ reason: string }>() })],
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      capabilities: [emits({ message: t<{ text: string }>() })],
    });
    const service = createTestService(base.assemble({ handlers: [general, rooms] }), { port: 0 });
    services.push(service);

    await service.ready;

    async function join(user: string, channel: { name: string; family?: string }) {
      const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/?user=${user}`);
      clients.push(socket);
      const messages = createMessageQueue(socket);
      await waitForOpen(socket);
      socket.send(JSON.stringify(['__subscribe__', {}, { channel }]));

      expect((await messages.next())[0]).toBe('__subscribeOk__');

      return messages;
    }

    async function appFramesUntilDone(messages: ReturnType<typeof createMessageQueue>) {
      const frames: unknown[] = [];
      for (let frame = await messages.next(); frame[0] !== 'done'; frame = await messages.next()) {
        if (!frame[0].startsWith('__')) frames.push(frame.slice(0, 2));
      }

      return frames;
    }

    const ada = await join('ada', { name: 'general' });
    const ben = await join('ben', { name: 'room:42', family: 'rooms' });
    const cy = await join('cy', { name: 'room:7', family: 'rooms' });

    const admin = await service.admin();
    admin.channels.broadcast('general', 'huddleClosing', { reason: 'maintenance' });
    admin.channels.broadcast({ family: 'rooms', name: 'room:42' }, 'message', { text: 'hi' });
    admin.channels.broadcast({ family: 'rooms', name: 'room:7' }, 'message', { text: 'seven' });
    admin.broadcast('done', {});

    expect(await appFramesUntilDone(ada)).toEqual([['huddleClosing', { reason: 'maintenance' }]]);
    expect(await appFramesUntilDone(ben)).toEqual([['message', { text: 'hi' }]]);
    expect(await appFramesUntilDone(cy)).toEqual([['message', { text: 'seven' }]]);
  });

  it('reconciles stale persisted connections when a new Node service starts', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const firstState: IntegrationState = { errors: [], shutdowns: 0 };
    const first = createTestService(buildServerDefinition(firstState), {
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
    const second = createTestService(buildServerDefinition(secondState), {
      port: 0,
      sql: database,
    });
    services.push(second);
    await second.ready;

    expect((await second.admin()).connectionCount).toBe(0);
  });

  it('closes a connected real client with going-away during shutdown', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
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
    const service = createTestService(buildServerDefinition(state), { port: 0 });
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

  it('drops upgrades that arrive after LiveThing shutdown starts', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = createTestService(buildServerDefinition(state), { port: 0 });
    services.push(service);
    await service.ready;

    await service.shutdownLiveThing();

    await expect(sendOpenUpgrade(serverPort(service.server), '/chat')).resolves.toBe('');
  });

  it('does not hand a reset socket to the WebSocket host after upgrade preparation', async () => {
    let started!: () => void;
    let finished = false;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });
    const definition = createServerDefinition({
      async authenticate(request) {
        started();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve()),
        );
        finished = true;
        return { userId: 'left' };
      },
    }).assemble({ handlers: [] });
    const webSocketServer = createFailingWebSocketServer();

    const service = createTestService(definition, {
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
    const definition = createServerDefinition({
      async authenticate(request) {
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

    const service = createTestService(definition, {
      port: 0,
      webSocketServer: webSocketServer.server,
    });
    services.push(service);
    await service.ready;

    const socket = await openPendingUpgrade(serverPort(service.server), '/chat');
    socket.on('error', () => {});
    await startedUpgrade;
    socket.end();

    await vi.waitFor(() => expect(aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(webSocketServer.attempts()).toBe(0);
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
