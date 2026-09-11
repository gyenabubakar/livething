import { createAdaptorServer } from '@hono/node-server';
import { client, connect } from '@wskit/client';
import { define, emits, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { setup } from './index.ts';

let lastClientIp: string | null = null;

const handler = define({
  upgrade(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectUpgrade(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectUpgrade(4001, 'No token');

    lastClientIp = request.headers.get('WSKit-Client-IP');

    return { userId: pathname.split('/').at(-1) ?? 'anonymous' };
  },
  capabilities: [
    emits({
      connected: t<{ userId: string; clientIp: string | null }>(),
      echoed: t<{ text: string }>(),
    }),
  ],
});

const echo = handler.on('echo', {
  run(ctx, input) {
    ctx.send('echoed', input as { text: string });
  },
});

handler.onConnect((ctx) => {
  ctx.send('connected', {
    userId: ctx.connection.userId,
    clientIp: lastClientIp,
  });
});

const assembled = handler.assemble({ handlers: [echo] });

interface RunningServer {
  port: number;
  close(): Promise<void>;
}

interface TestClient {
  incoming: { connected: unknown; echoed: unknown };
  outgoing: { echo: { text: string } };
}

function listen(
  app: Hono,
  websocket: { server: WebSocketServer },
  shutdown: () => Promise<void>,
): Promise<RunningServer> {
  const server = createAdaptorServer({ fetch: app.fetch, websocket });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

      resolve({
        port: address.port,
        async close() {
          await shutdown();
          await new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          );
        },
      });
    });
  });
}

function waitForMessage(
  socket: WebSocket,
): Promise<{ event: string; payload: { userId?: string; text?: string } }> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.once('error', reject);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('Hono binding', () => {
  const servers: RunningServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('uses Hono route matching while WSKit handles the accepted socket', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    await wskit.ready();

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await expect(connected).resolves.toMatchObject({ event: 'connected' });

    socket.send(JSON.stringify({ event: 'echo', payload: { text: 'hello' } }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({ event: 'echoed' });
  });

  it('applies the endpoint client IP configuration to the Node request', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, { clientIp: { mode: 'direct' } });
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'connected',
      payload: { clientIp: '127.0.0.1' },
    });
  });

  it('returns an HTTP rejection before Hono upgrades the connection', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/ws/http-reject`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('No token');
  });

  it('upgrades then closes a socket-level rejection', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/socket-reject`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('works with the packaged WSKit client', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    const socket = client<TestClient>()(connect(`ws://127.0.0.1:${server.port}/ws/lobby`));
    const connected = new Promise<void>((resolve) => socket.on('connected', () => resolve()));
    const echoed = new Promise<void>((resolve) => socket.on('echoed', () => resolve()));
    socket.connect();

    await connected;
    expect(socket.send('echo', { text: 'hello' })).toBe(true);
    await echoed;
    socket.disconnect();
  });
});
