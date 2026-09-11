import websocket from '@fastify/websocket';
import { client, connect } from '@wskit/client';
import { define, emits, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
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

async function createApp(options: { clientIp?: { mode: 'direct' } } = {}) {
  const app = Fastify();
  await app.register(websocket);
  const wskit = setup();
  const endpoint = wskit.bind(assembled, options);
  app.get('/ws/:room', endpoint.upgrade);

  await wskit.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

  return {
    app,
    port: address.port,
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
