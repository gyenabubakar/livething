import { connect as connectTcp } from 'node:net';
import { client, connect } from '@wskit/client';
import { define, emits, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { serve } from 'crossws/server/node';
import { H3 } from 'h3/node';
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
  const app = new H3();
  const wskit = setup();
  const endpoint = wskit.bind(assembled, options);
  app.get('/ws/:room', endpoint.upgrade);
  await wskit.ready();

  const served = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, websocket: {} });
  const server = served.node?.server;
  if (!server) throw new Error('Expected a Node server');

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

  return {
    port: address.port,
    shutdown: async () => {
      await wskit.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
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

function sendUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.end(
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
    socket.on('data', (chunk) => {
      response += chunk;
    });

    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

describe('H3 binding', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  });

  it('uses H3 route parameters and forwards messages through WSKit', async () => {
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

  it('closes binary frames with code 1003', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    socket.send(Buffer.from('binary'));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: '[wskit] binary frames are not supported yet',
    });
  });

  it('returns an HTTP rejection through CrossWS before a WebSocket handshake', async () => {
    const app = await createApp();
    apps.push(app);

    const response = await sendUpgrade(app.port, '/ws/http-reject');
    expect(response).toContain('HTTP/1.1 401');
    expect(response).toContain('No token');
  });

  it('closes a socket-level rejection after CrossWS upgrades it', async () => {
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
