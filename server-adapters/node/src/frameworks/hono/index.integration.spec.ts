import { connect as connectTcp } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { client, connect } from '@livething/client';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { RejectUpgrade } from '@livething/server/errors';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { setup } from './index.ts';

let lastClientIp: string | null = null;
let disconnects = 0;
let lastDisconnect: { code: number; reason: string } | undefined;

const base = createServerDefinition({
  upgrade(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectUpgrade(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectUpgrade(4001, 'No token');

    if (pathname.endsWith('/socket-reject-long')) throw RejectUpgrade(4001, '🙂'.repeat(100));

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

    lastClientIp = request.headers.get('LiveThing-Client-IP');

    return { userId: pathname.split('/').at(-1) ?? 'anonymous' };
  },
  capabilities: [
    emits({
      connected: t<{ userId: string; clientIp: string | null }>(),
      echoed: t<{ text: string }>(),
    }),
  ],
  onConnect(ctx) {
    ctx.send('connected', {
      userId: ctx.connection.userId,
      clientIp: lastClientIp,
    });
  },
  onDisconnect(ctx) {
    disconnects += 1;
    lastDisconnect = { code: ctx.closeCode ?? 1000, reason: ctx.closeReason ?? '' };
  },
});

const echo = base.on('echo', {
  run(ctx, input) {
    ctx.send('echoed', input as { text: string });
  },
});

const assembled = base.assemble({ handlers: [echo] });

interface TestClient {
  incoming: {
    connected: { userId: string; clientIp: string | null };
    echoed: { text: string };
  };
  outgoing: { echo: { text: string } };
}

interface RunningServer {
  port: number;
  close(): Promise<void>;
}

type WireFrame = readonly [event: string, payload: unknown, metadata: null];

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

function waitForMessage(socket: WebSocket): Promise<WireFrame> {
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

    socket.once('close', () => resolve(response));
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
    lastDisconnect = undefined;
  });

  async function startLobby() {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await livething.ready();

    return { livething, server };
  }

  async function openLobbySocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    return socket;
  }

  it('uses Hono route matching while LiveThing handles the accepted socket', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await livething.ready();

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await expect(connected).resolves.toEqual(['connected', expect.any(Object), null]);

    socket.send(JSON.stringify(['echo', { text: 'hello' }, null]));
    await expect(waitForMessage(socket)).resolves.toEqual(['echoed', { text: 'hello' }, null]);
  });

  it('sets maxMessageBytes on the shared WebSocket server, so a bigger message closes with 1009', async () => {
    const app = new Hono();
    const livething = setup({ maxMessageBytes: 1024 });
    const endpoint = livething.bind(assembled, { maxMessageBytes: 1024 });
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await livething.ready();

    expect(livething.websocket.server.options.maxPayload).toBe(1024);
    const socket = await openLobbySocket(server.port);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send('x'.repeat(2000));

    expect(await closed).toBe(1009);
  });

  it('refuses a maxMessageBytes that ws cannot hold, and both webSocketServer and maxMessageBytes', () => {
    for (const maxMessageBytes of [0, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => setup({ maxMessageBytes })).toThrow(/setup\(\) maxMessageBytes must be/);
    }

    expect(() =>
      setup({ webSocketServer: new WebSocketServer({ noServer: true }), maxMessageBytes: 1024 }),
    ).toThrow(/both webSocketServer and maxMessageBytes/);
  });

  it('refuses an endpoint maxMessageBytes larger than the shared server limit', () => {
    const livething = setup({ maxMessageBytes: 1024 });

    expect(() => livething.bind(assembled, { maxMessageBytes: 2048 })).toThrow(
      /maxMessageBytes \(2048\) is larger than the shared WebSocket server limit \(1024\)/,
    );
  });

  it('uses a caller-provided WebSocket server', async () => {
    const app = new Hono();
    const webSocketServer = new WebSocketServer({ noServer: true });
    const close = vi.spyOn(webSocketServer, 'close');
    const livething = setup({ webSocketServer });

    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    expect(livething.websocket.server).toBe(webSocketServer);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);
    await expect(waitForMessage(socket)).resolves.toEqual(['connected', expect.any(Object), null]);

    await livething.shutdown();
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it('applies the endpoint client IP configuration to the Node request', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, { clientIp: { mode: 'direct' } });
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`);
    sockets.push(socket);

    await expect(waitForMessage(socket)).resolves.toEqual([
      'connected',
      { userId: 'lobby', clientIp: '127.0.0.1' },
      null,
    ]);
  });

  it('derives the client IP through a trusted proxy before Hono upgrades', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {
      clientIp: { mode: 'proxy', trustedProxies: ['127.0.0.1', '::1'] },
    });
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/lobby`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    sockets.push(socket);
    const connected = waitForMessage(socket);

    await waitForOpen(socket);
    await expect(connected).resolves.toEqual([
      'connected',
      { userId: 'lobby', clientIp: '203.0.113.7' },
      null,
    ]);
  });

  it('reports the real outbound queue while a Hono client is slow', async () => {
    const queued = createServerDefinition({
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
    const livething = setup();
    const endpoint = livething.bind(queued.assemble({ handlers: [fillQueue] }), {});

    app.get('/ws/slow-client', endpoint.upgrade);
    const runningServer = await listen(app, livething.websocket, () => livething.shutdown());
    servers.push(runningServer);

    const socket = new WebSocket(`ws://127.0.0.1:${runningServer.port}/ws/slow-client`);
    sockets.push(socket);
    await waitForOpen(socket);

    const queuedAmount = new Promise<number>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as WireFrame;
        if (message[0] === 'queued') resolve((message[1] as { amount: number }).amount);
      });
      socket.once('error', reject);
    });

    const clientSocket = getClientSocket(socket);
    clientSocket.pause();
    socket.send(JSON.stringify(['fill-queue', {}, null]));
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
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(slowDefinition, {});
    app.get('/ws/slow', endpoint.upgrade);

    const runningServer = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(runningServer);
    const socket = new WebSocket(`ws://127.0.0.1:${runningServer.port}/ws/slow`);
    sockets.push(socket);
    socket.on('error', () => {});
    await startedUpgrade;

    const shutdown = livething.shutdown();
    let stopped = false;
    void shutdown.then(() => {
      stopped = true;
    });

    try {
      await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 100 });
      expect(stopped).toBe(false);
      await expect(sendOpenUpgrade(runningServer.port, '/ws/slow')).resolves.toBe('');
    } finally {
      release();
    }

    await shutdown;
  });

  it('drops upgrades that arrive after LiveThing shutdown starts', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);

    await livething.shutdown();

    await expect(sendOpenUpgrade(server.port, '/ws/lobby')).resolves.toBe('');
  });

  it('keeps the connection until close after a transport error', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await sendInvalidClientFrame(server.port, '/ws/lobby');
    await vi.waitFor(() => expect(disconnects).toBe(1));
  });

  it('returns an HTTP rejection before Hono upgrades the connection', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);

    const response = await sendUpgrade(server.port, '/ws/http-reject');
    expect(response).toMatch(/^HTTP\/1\.1 401 /);
    expect(response).toMatch(/^content-type: text\/plain/im);
    // @hono/node-server sends the status and headers of a refused upgrade, not its body.
    expect(response).not.toContain('No token');
  });

  it('passes a plain HTTP request to the next Hono handler without running upgrade', async () => {
    const upgrade = vi.fn(() => ({ userId: 'plain' }));
    const definition = createServerDefinition({ upgrade }).assemble({ handlers: [] });
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(definition, {});

    app.get('/ws/:room', endpoint.upgrade, (context) => context.text('plain page'));
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await livething.ready();

    const response = await fetch(`http://127.0.0.1:${server.port}/ws/lobby`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('plain page');
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('does not run upgrade for a plain HTTP request when no other Hono handler matches', async () => {
    const upgrade = vi.fn(() => ({ userId: 'plain' }));
    const definition = createServerDefinition({ upgrade }).assemble({ handlers: [] });
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(definition, {});

    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);
    await livething.ready();

    const response = await fetch(`http://127.0.0.1:${server.port}/ws/lobby`);
    expect(response.status).toBe(404);
    expect(upgrade).not.toHaveBeenCalled();
  });
  it('upgrades then closes a socket-level rejection', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/socket-reject`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('trims a long socket rejection reason to the WebSocket control-frame limit', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/socket-reject-long`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: '🙂'.repeat(30) });
  });

  it('closes with an internal error when connection setup fails after upgrade', async () => {
    const app = new Hono();
    const livething = setup();
    const endpoint = livething.bind(assembled, {});
    app.get('/ws/:room', endpoint.upgrade);
    const server = await listen(app, livething.websocket, () => livething.shutdown());

    servers.push(server);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/accept-failure`);
    sockets.push(socket);
    const closed = waitForClose(socket);
    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: '[livething] connection setup failed',
    });
  });

  it('works with the LiveThing client', async () => {
    const { server } = await startLobby();
    const socket = client<TestClient>()(connect(`ws://127.0.0.1:${server.port}/ws/lobby`));
    const connected = new Promise<{ userId: string }>((resolve) => socket.on('connected', resolve));
    const echoed = new Promise<{ text: string }>((resolve) => socket.on('echoed', resolve));

    try {
      socket.connect();

      await expect(connected).resolves.toEqual({ userId: 'lobby', clientIp: null });
      expect(socket.send('echo', { text: 'hello' })).toBe(true);
      await expect(echoed).resolves.toEqual({ text: 'hello' });
    } finally {
      socket.disconnect();
    }
  });

  it('closes binary frames with code 1003 without rejecting text frames', async () => {
    const { server } = await startLobby();
    const socket = await openLobbySocket(server.port);

    const echoed = waitForMessage(socket);
    socket.send(JSON.stringify(['echo', { text: 'text' }, null]));
    await expect(echoed).resolves.toEqual(['echoed', { text: 'text' }, null]);

    const closed = waitForClose(socket);
    socket.send(Buffer.from('binary'));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: '[livething] binary frames are not supported yet',
    });
    await vi.waitFor(() => expect(lastDisconnect?.code).toBe(1003));
  });

  it('passes the client close code and reason to onDisconnect', async () => {
    const { server } = await startLobby();
    const socket = await openLobbySocket(server.port);

    socket.close(4000, 'client finished');

    await vi.waitFor(() =>
      expect(lastDisconnect).toEqual({ code: 4000, reason: 'client finished' }),
    );
  });

  it('closes connected clients with going-away during shutdown', async () => {
    const { livething, server } = await startLobby();
    const socket = await openLobbySocket(server.port);
    const closed = waitForClose(socket);

    await livething.shutdown();

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(lastDisconnect).toEqual({ code: 1001, reason: 'Server shutting down' });
  });
});
