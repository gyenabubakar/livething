import process from 'node:process';
import { define, emits, t, translator } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { scheduled } from '@wskit/server/scheduled';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { server } from './server.ts';
import type { NodeServer } from './server.ts';
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

function createHandler(state: IntegrationState) {
  const base = define({
    env: t<{ TEST_SECRET: string }>(),
    upgrade(request) {
      state.upgradeRequest = request;
      const url = new URL(request.url);
      if (url.pathname === '/reject') throw RejectUpgrade(401, 'No token');
      if (url.pathname === '/reject-socket') throw RejectUpgrade(4001, 'No token');
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

  const integrationTask = base.scheduled('integration-task', {
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
    handlers: [echo, store, schedule, buffered, integrationTask],
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
    env: t<{ TEST_SECRET: string }>(),
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

describe('Node server integration', () => {
  const services: NodeServer[] = [];
  const clients: WebSocket[] = [];
  const databases: Database.Database[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(closeClient));
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    for (const database of databases.splice(0)) database.close();
  });

  it('passes the complete upgrade request and routes real text frames through the engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), {
      port: 0,
      env: { TEST_SECRET: 'integration-secret' },
      clientIp: { mode: 'direct' },
      shutdownOnSignal: false,
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

  it('rejects a real upgrade with an HTTP response', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject`);
    clients.push(socket);

    await expect(waitForOpen(socket)).rejects.toThrow();
    expect(state.upgradeRequest).toBeDefined();
  });

  it('rejects a real upgrade with a WebSocket close decision', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/reject-socket`);
    clients.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('rejects binary frames through the real bridge', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
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
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
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
    const service = server(createHandler(state), {
      port: 0,
      webSocketServer: captured.server,
      shutdownOnSignal: false,
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
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
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

    socket.send(JSON.stringify({ event: 'schedule', payload: {} }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'scheduledQueued',
      payload: { ok: true },
    });
    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'scheduled',
      payload: { text: 'from alarm' },
    });
  });

  it('exposes the live Node buffer amount through the engine context', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
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
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const announcement = waitForMessage(socket);
    expect(service.admin().announce('from admin')).toBe(1);
    await expect(announcement).resolves.toMatchObject({
      event: 'adminAnnouncement',
      payload: { text: 'from admin' },
    });
  });

  it('reconciles stale persisted connections when a new Node service starts', async () => {
    const database = new Database(':memory:');
    databases.push(database);
    const firstState: IntegrationState = { errors: [], shutdowns: 0 };
    const first = server(createHandler(firstState), {
      port: 0,
      sql: database,
      shutdownOnSignal: false,
    });
    services.push(first);
    await first.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(first.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;
    expect(first.admin().connectionCount).toBe(1);

    const secondState: IntegrationState = { errors: [], shutdowns: 0 };
    const second = server(createHandler(secondState), {
      port: 0,
      sql: database,
      shutdownOnSignal: false,
    });
    services.push(second);
    await second.ready;

    expect(second.admin().connectionCount).toBe(0);
  });

  it('translates inbound and outbound frames through the real engine', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createTranslatedHandler(state), {
      port: 0,
      shutdownOnSignal: false,
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
    const service = server(createHandler(state), { port: 0, shutdownOnSignal: false });
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

  it('shuts down on SIGTERM for an owned server', async () => {
    const state: IntegrationState = { errors: [], shutdowns: 0 };
    const service = server(createHandler(state), { port: 0 });
    services.push(service);
    await service.ready;

    const socket = new WebSocket(`ws://127.0.0.1:${serverPort(service.server)}/chat`);
    clients.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    const closed = waitForClose(socket);
    process.emit('SIGTERM');

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    await service.shutdown();
    expect(state.shutdowns).toBe(1);
  });
});
