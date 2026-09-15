import { connect as connectTcp } from 'node:net';
import websocket from '@fastify/websocket';
import { client, connect } from '@wskit/client';
import { define, emits, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerDefinition } from '@wskit/server/adapters';
import { setup } from './index.ts';
import type { NodeEndpointOptions } from '../../binding.ts';

let lastClientIp: string | null = null;

const handler = define({
  upgrade(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectUpgrade(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectUpgrade(4001, 'No token');

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

    lastClientIp = request.headers.get('WSKit-Client-IP');

    return { userId: pathname.split('/').at(-1) ?? 'anonymous' };
  },
  capabilities: [
    emits({
      connected: t<{ clientIp: string | null }>(),
      echoed: t(),
    }),
  ],
});

const echo = handler.on('echo', {
  run(ctx, input) {
    ctx.send('echoed', input);
  },
});

handler.onConnect((ctx) => {
  ctx.send('connected', { clientIp: lastClientIp });
});

const assembled = handler.assemble({ handlers: [echo] });

interface TestClient {
  incoming: { connected: unknown; echoed: unknown };
  outgoing: { echo: { text: string } };
}

async function createApp(
  options: Pick<NodeEndpointOptions, 'clientIp'> = {},
  definition: ServerDefinition = assembled,
) {
  const app = Fastify();
  await app.register(websocket);
  const wskit = setup();
  const endpoint = wskit.bind(definition, options);
  app.get('/ws/:room', endpoint.upgrade);

  await wskit.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

  return {
    app,
    port: address.port,
    wskit,
    shutdown: async () => {
      await wskit.shutdown();
      await app.close();
    },
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<{ event: string }> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sendOpenUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
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
          `GET ${path} HTTP/1.1`,
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
    socket.on('data', (data) => {
      response += data;
      finish();
    });
    socket.once('close', () => finish());
    socket.once('error', finish);
  });
}

describe('Fastify binding', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  });

  it('uses Fastify route parameters and forwards messages through WSKit', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);

    await waitForOpen(socket);
    await expect(connected).resolves.toMatchObject({ event: 'connected' });

    socket.send(JSON.stringify({ event: 'echo', payload: {} }));
    await expect(waitForMessage(socket)).resolves.toMatchObject({ event: 'echoed' });
  });

  it('applies the endpoint client IP configuration to the Node request', async () => {
    const app = await createApp({ clientIp: { mode: 'direct' } });
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    sockets.push(socket);

    await expect(waitForMessage(socket)).resolves.toMatchObject({
      event: 'connected',
      payload: { clientIp: '127.0.0.1' },
    });
  });

  it('derives the client IP through a trusted proxy before Fastify upgrades', async () => {
    const app = await createApp({
      clientIp: { mode: 'proxy', trustedProxies: ['127.0.0.1', '::1'] },
    });
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    sockets.push(socket);
    const connected = waitForMessage(socket);

    await waitForOpen(socket);
    await expect(connected).resolves.toMatchObject({
      event: 'connected',
      payload: { clientIp: '203.0.113.7' },
    });
  });

  it('cancels a pending upgrade before shutdown', async () => {
    let release!: () => void;
    let started!: () => void;
    let aborted = false;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releaseUpgrade = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slowHandler = define({
      async upgrade(request) {
        started();
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await releaseUpgrade;
        return { userId: 'slow' };
      },
    }).assemble({ handlers: [] });
    const app = await createApp({}, slowHandler);

    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow`);
    sockets.push(socket);
    socket.on('error', () => {});
    await startedUpgrade;

    const shutdown = app.wskit.shutdown();
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });

    try {
      await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 100 });
      expect(stopped).toBe(false);
      await expect(sendOpenUpgrade(app.port, '/ws/second')).resolves.toBe('');
    } finally {
      release();
    }

    await shutdown;
  });

  it('drops upgrades that arrive after WSKit shutdown starts', async () => {
    const app = await createApp();
    apps.push(app);

    await app.wskit.shutdown();

    await expect(sendOpenUpgrade(app.port, '/ws/lobby')).resolves.toBe('');
  });

  it('rejects before upgrade through Fastify preHandler', async () => {
    const app = await createApp();
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${app.port}/ws/http-reject`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('No token');
  });

  it('closes a socket-level rejection after Fastify upgrades it', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject`);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('closes with an internal error when connection setup fails after upgrade', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/accept-failure`);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: '[wskit] connection setup failed',
    });
  });

  it('works with the packaged WSKit client', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = client<TestClient>()(connect(`ws://127.0.0.1:${app.port}/ws/lobby`));
    const connected = new Promise<void>((resolve) => socket.on('connected', () => resolve()));
    const echoed = new Promise<void>((resolve) => socket.on('echoed', () => resolve()));

    socket.connect();

    await connected;
    expect(socket.send('echo', { text: 'hello' })).toBe(true);
    await echoed;
    socket.disconnect();
  });
});
