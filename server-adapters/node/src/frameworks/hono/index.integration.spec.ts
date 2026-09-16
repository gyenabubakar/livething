import { connect as connectTcp } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { client, connect } from '@wskit/client';
import { define, emits, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { setup } from './index.ts';

let lastClientIp: string | null = null;
let disconnects = 0;

const handler = define({
  upgrade(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectUpgrade(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectUpgrade(4001, 'No token');

    if (pathname.endsWith('/socket-reject-long')) throw RejectUpgrade(4001, '🙂'.repeat(100));

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

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

handler.onDisconnect(() => {
  disconnects += 1;
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

function getClientSocket(socket: WebSocket): { pause(): void; resume(): void } {
  const webSocket = socket as WebSocket & {
    _socket?: { pause(): void; resume(): void };
  };

  if (!webSocket._socket) {
    throw new Error('Expected the WebSocket client to have a TCP socket');
  }

  return webSocket._socket;
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
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

describe('Hono binding', () => {
  const servers: RunningServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    disconnects = 0;
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

  it('uses a caller-provided WebSocket server', async () => {
    const app = new Hono();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const close = vi.spyOn(webSocketServer, 'close');
    const wskit = setup({ webSocketServer });

    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    expect(wskit.websocket.server).toBe(webSocketServer);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);
    await expect(waitForMessage(socket)).resolves.toMatchObject({ event: 'connected' });

    await wskit.shutdown();
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
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

  it('derives the client IP through a trusted proxy before Hono upgrades', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {
      clientIp: { mode: 'proxy', trustedProxies: ['127.0.0.1', '::1'] },
    });
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`, {
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

  it('reports the real outbound queue while a Hono client is slow', async () => {
    const queued = define({
      upgrade() {
        return { userId: 'slow-client' };
      },
      capabilities: [
        emits({
          chunk: t<{ data: string }>(),
          queued: t<{ amount: number }>(),
        }),
      ],
    });
    const fillQueue = queued.on('fill-queue', {
      run(ctx) {
        const chunk = { data: 'x'.repeat(1024 * 1024) };
        for (let index = 0; index < 16; index += 1) ctx.send('chunk', chunk);
        ctx.send('queued', { amount: ctx.bufferedAmount });
      },
    });
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(queued.assemble({ handlers: [fillQueue] }), {});

    app.get('/ws/slow-client', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());
    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/slow-client`);
    sockets.push(socket);
    await waitForOpen(socket);

    const queuedAmount = new Promise<number>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          event: string;
          payload: { amount: number };
        };
        if (message.event === 'queued') resolve(message.payload.amount);
      });
      socket.once('error', reject);
    });

    const clientSocket = getClientSocket(socket);
    clientSocket.pause();
    socket.send(JSON.stringify({ event: 'fill-queue', payload: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    clientSocket.resume();

    await expect(queuedAmount).resolves.toBeGreaterThan(0);
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
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(slowHandler, {});
    app.get('/ws/slow', endpoint.upgrade);

    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/slow`);
    sockets.push(socket);
    socket.on('error', () => {});
    await startedUpgrade;

    const shutdown = wskit.shutdown();
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });

    try {
      await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 100 });
      expect(stopped).toBe(false);
      await expect(sendOpenUpgrade(server.port, '/ws/slow')).resolves.toBe('');
    } finally {
      release();
    }

    await shutdown;
  });

  it('drops upgrades that arrive after WSKit shutdown starts', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    await wskit.shutdown();

    await expect(sendOpenUpgrade(server.port, '/ws/lobby')).resolves.toBe('');
  });

  it('keeps the connection until close after a transport error', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);
    await sendInvalidClientFrame(server.port, '/ws/lobby');
    await vi.waitFor(() => expect(disconnects).toBe(1));
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

  it('trims a long socket rejection reason to the WebSocket control-frame limit', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/socket-reject-long`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: '🙂'.repeat(30) });
  });

  it('closes with an internal error when connection setup fails after upgrade', async () => {
    const app = new Hono();
    const wskit = setup();
    const endpoint = wskit.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, wskit.websocket, () => wskit.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/accept-failure`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: '[wskit] connection setup failed',
    });
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
