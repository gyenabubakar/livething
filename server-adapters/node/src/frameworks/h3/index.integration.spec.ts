import { connect as connectTcp } from 'node:net';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { RejectUpgrade } from '@livething/server/errors';
import { serve } from 'crossws/server/node';
import { H3 } from 'h3/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerDefinition } from '@livething/server/adapters';
import { setup } from './index.ts';
import type { NodeEndpointOptions } from '../../binding.ts';

let lastClientIp: string | null = null;
let disconnects = 0;

const base = createServerDefinition({
  upgrade(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectUpgrade(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectUpgrade(4001, 'No token');

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

    lastClientIp = request.headers.get('LiveThing-Client-IP');

    return { userId: pathname.split('/').at(-1) ?? 'anonymous' };
  },
  capabilities: [
    emits({
      connected: t<{ clientIp: string | null }>(),
      echoed: t(),
    }),
  ],
});

const echo = base.on('echo', {
  run(ctx, input) {
    ctx.send('echoed', input);
  },
});

base.onConnect((ctx) => {
  ctx.send('connected', { clientIp: lastClientIp });
});

base.onDisconnect(() => {
  disconnects += 1;
});

const assembled = base.assemble({ handlers: [echo] });

type WireFrame = readonly [event: string, payload: unknown, metadata: null];

async function createApp(
  options: Pick<NodeEndpointOptions, 'clientIp'> = {},
  definition: ServerDefinition = assembled,
) {
  const app = new H3();
  const livething = setup();
  const endpoint = livething.bind(definition, options);
  app.get('/ws/:room', endpoint.upgrade);
  await livething.ready();

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
    livething,
    shutdown: async () => {
      await livething.shutdown();
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

function waitForMessage(socket: WebSocket): Promise<WireFrame> {
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

function sendNonWebSocketUpgrade(port: number, path: string): Promise<string> {
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

function sendInvalidClientFrame(port: number, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1');
    let upgraded = false;
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error('Timed out waiting for the invalid WebSocket frame to close'));
    });
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
      if (upgraded) return;

      if (!data.toString().startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error('Expected a WebSocket upgrade response'));
        return;
      }

      upgraded = true;
      socket.write(Buffer.from([0x81, 0x01, 0x61]));
    });

    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
}

describe('H3 binding', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(apps.splice(0).map((app) => app.shutdown()));
    disconnects = 0;
  });

  it('uses H3 route parameters and forwards messages through LiveThing', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);

    await waitForOpen(socket);
    await expect(connected).resolves.toEqual(['connected', expect.any(Object), null]);

    socket.send(JSON.stringify(['echo', {}, null]));
    await expect(waitForMessage(socket)).resolves.toEqual(['echoed', {}, null]);
  });

  it('applies the endpoint client IP configuration to the Node request', async () => {
    const app = await createApp({ clientIp: { mode: 'direct' } });
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    sockets.push(socket);

    await expect(waitForMessage(socket)).resolves.toEqual([
      'connected',
      { clientIp: '127.0.0.1' },
      null,
    ]);
  });

  it('derives the client IP through a trusted proxy before H3 upgrades', async () => {
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
    await expect(connected).resolves.toEqual(['connected', { clientIp: '203.0.113.7' }, null]);
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

    const slowDefinition = createServerDefinition({
      async upgrade(request) {
        started();
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await releaseUpgrade;
        return { userId: 'slow' };
      },
    }).assemble({ handlers: [] });
    const app = await createApp({}, slowDefinition);

    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow`);
    sockets.push(socket);
    socket.on('error', () => {});
    await startedUpgrade;

    const shutdown = app.livething.shutdown();
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

  it('drops upgrades that arrive after LiveThing shutdown starts', async () => {
    const app = await createApp();
    apps.push(app);

    await app.livething.shutdown();

    await expect(sendOpenUpgrade(app.port, '/ws/lobby')).resolves.toBe('');
  });

  it('keeps the connection until close after a transport error', async () => {
    const app = await createApp();
    apps.push(app);

    await sendInvalidClientFrame(app.port, '/ws/lobby');
    await vi.waitFor(() => expect(disconnects).toBe(1));
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
      reason: '[livething] binary frames are not supported yet',
    });
  });

  it('returns an HTTP rejection through CrossWS before a WebSocket handshake', async () => {
    const app = await createApp();
    apps.push(app);

    const response = await sendUpgrade(app.port, '/ws/http-reject');
    expect(response).toContain('HTTP/1.1 401');
    expect(response).toContain('No token');
  });

  it('answers a plain HTTP request with 426 without running upgrade', async () => {
    const upgrade = vi.fn(() => ({ userId: 'plain' }));
    const app = await createApp({}, createServerDefinition({ upgrade }).assemble({ handlers: [] }));
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${app.port}/ws/lobby`);
    expect(response.status).toBe(426);
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('does not run upgrade for a non-WebSocket upgrade request', async () => {
    const upgrade = vi.fn(() => ({ userId: 'plain' }));
    const app = await createApp({}, createServerDefinition({ upgrade }).assemble({ handlers: [] }));
    apps.push(app);

    const response = await sendNonWebSocketUpgrade(app.port, '/ws/lobby');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(upgrade).not.toHaveBeenCalled();
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

  it('closes with an internal error when connection setup fails after upgrade', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/accept-failure`);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: '[livething] connection setup failed',
    });
  });
});
