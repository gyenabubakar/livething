import { createServer } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { client, connect } from '@livething/client';
import { server as createServerDefinition, emits, t } from '@livething/server';
import { RejectAuth } from '@livething/server/errors';
import nodeWebSocketAdapter from 'crossws-v1/adapters/node';
import { createApp, createRouter, defineWebSocketHandler, toNodeListener } from 'h3-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerDefinition } from '@livething/server/adapters';
import type { AddressInfo } from 'node:net';
import { capturedBridges, nextRawMessage } from '../../../test-utils.ts';
import { createH3V1Setup } from './setup.ts';

vi.mock('../../../socket.ts', async (importOriginal) => {
  const { captureBridges } = await import('../../../test-utils.ts');
  return captureBridges(await importOriginal());
});

let lastUserId = '';
let disconnects = 0;
let lastClientIp: string | null = null;
let lastAuthorization: string | null = null;
// What @livething/client offers for the token 'session-8f2c'.
const TOKEN_OFFER = [
  'livething-v1',
  `livething-v1.token.${Buffer.from('session-8f2c').toString('base64url')}`,
];
let lastDisconnect: { code: number; reason: string } | undefined;
let transportErrors = 0;

const base = createServerDefinition({
  authenticate(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectAuth(401, 'No token');

    if (pathname.endsWith('/socket-reject-long')) {
      throw RejectAuth(4001, '🙂'.repeat(50));
    }

    if (pathname.endsWith('/socket-reject')) throw RejectAuth(4001, 'No token');

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

    lastUserId = pathname.split('/').at(-1) ?? 'anonymous';
    lastClientIp = request.headers.get('LiveThing-Client-IP');
    lastAuthorization = request.headers.get('authorization');

    return { userId: lastUserId };
  },
  capabilities: [
    emits({
      connected: t<{ clientIp: string | null; userId: string }>(),
      echoed: t<{ text: string }>(),
    }),
  ],
  onConnect(ctx) {
    ctx.send('connected', { clientIp: lastClientIp, userId: lastUserId });
  },
  onDisconnect(ctx) {
    disconnects += 1;
    lastDisconnect = { code: ctx.closeCode ?? 1000, reason: ctx.closeReason ?? '' };
  },
  onError() {
    transportErrors += 1;
  },
});

const echo = base.on('echo', {
  run(ctx, input: { text: string }) {
    ctx.send('echoed', input);
  },
});

const definition = base.assemble({ handlers: [echo] });

interface TestClient {
  incoming: {
    connected: { clientIp: string | null; userId: string };
    echoed: { text: string };
  };
  outgoing: { echo: { text: string } };
}

async function createTestApp(
  serverDefinition: ServerDefinition = definition,
  serverOptions: { perMessageDeflate?: boolean } = {},
) {
  const app = createApp();
  const router = createRouter();
  const livething = createH3V1Setup(defineWebSocketHandler);
  const endpoint = livething.bind(serverDefinition, { sql: ':memory:' });

  router.get('/ws/:room', endpoint.upgrade);
  app.use(router);

  const websocket = nodeWebSocketAdapter({ ...app.websocket, serverOptions });
  const server = createServer(toNodeListener(app));
  server.on('upgrade', websocket.handleUpgrade);

  await livething.ready();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  return {
    livething,
    port: (server.address() as AddressInfo).port,
    async shutdown() {
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

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function waitForRawMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

function getClientSocket(socket: WebSocket): { pause(): void; resume(): void } {
  const clientSocket = (
    socket as WebSocket & {
      _socket?: { pause(): void; resume(): void };
    }
  )._socket;

  if (!clientSocket) throw new Error('Expected the WebSocket client to have a TCP socket');

  return clientSocket;
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

type H3V1Hooks = Parameters<Parameters<typeof createH3V1Setup>[0]>[0];

function captureAuthHook(serverDefinition: ServerDefinition) {
  let hooks!: H3V1Hooks;
  const livething = createH3V1Setup((value) => {
    hooks = value;
    return value;
  });
  const endpoint = livething.bind(serverDefinition, { sql: ':memory:' });

  return { endpoint, hooks, livething };
}

describe('H3 v1 binding', () => {
  const apps: Array<Awaited<ReturnType<typeof createTestApp>>> = [];
  const sockets: Array<{ disconnect(): void }> = [];
  const rawSockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    for (const socket of rawSockets.splice(0)) socket.terminate();
    await Promise.all(apps.splice(0).map((app) => app.shutdown()));
    disconnects = 0;
    lastClientIp = null;

    lastDisconnect = undefined;
    transportErrors = 0;
  });

  it('uses an H3 v1 route and forwards messages through LiveThing', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = client<TestClient>()(connect(`ws://127.0.0.1:${app.port}/ws/lobby`));
    sockets.push(socket);

    const connected = new Promise<{ userId: string }>((resolve) => socket.on('connected', resolve));
    const echoed = new Promise<{ text: string }>((resolve) => socket.on('echoed', resolve));

    socket.connect();

    await expect(connected).resolves.toEqual({ clientIp: null, userId: 'lobby' });
    expect(socket.send('echo', { text: 'hello' })).toBe(true);
    await expect(echoed).resolves.toEqual({ text: 'hello' });
  });

  it('keeps endpoints isolated when one setup binds more than one route', async () => {
    function namedDefinition(name: string) {
      const named = createServerDefinition({
        authenticate() {
          return { userId: name };
        },
        capabilities: [emits({ identity: t<{ name: string }>() })],
        onConnect(ctx) {
          ctx.send('identity', { name });
        },
      });
      return named.assemble({ handlers: [] });
    }

    const app = createApp();
    const router = createRouter();
    const livething = createH3V1Setup(defineWebSocketHandler);
    const first = livething.bind(namedDefinition('first'), { sql: ':memory:' });
    const second = livething.bind(namedDefinition('second'), { sql: ':memory:' });

    router.get('/first', first.upgrade);
    router.get('/second', second.upgrade);
    app.use(router);

    const websocket = nodeWebSocketAdapter(app.websocket);
    const server = createServer(toNodeListener(app));
    server.on('upgrade', websocket.handleUpgrade);

    await livething.ready();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    apps.push({
      livething,
      port,
      async shutdown() {
        await livething.shutdown();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    });

    const firstSocket = new WebSocket(`ws://127.0.0.1:${port}/first`);
    const secondSocket = new WebSocket(`ws://127.0.0.1:${port}/second`);
    rawSockets.push(firstSocket, secondSocket);
    const firstMessage = waitForRawMessage(firstSocket);
    const secondMessage = waitForRawMessage(secondSocket);

    await Promise.all([waitForOpen(firstSocket), waitForOpen(secondSocket)]);
    await expect(firstMessage).resolves.toEqual(['identity', { name: 'first' }, null]);
    await expect(secondMessage).resolves.toEqual(['identity', { name: 'second' }, null]);
  });

  it('answers the token subprotocol and passes the token to authenticate', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`, TOKEN_OFFER);
    rawSockets.push(socket);

    await waitForOpen(socket);
    expect(socket.protocol).toBe('livething-v1');
    expect(lastAuthorization).toBe('Bearer session-8f2c');
  });

  it('answers the token subprotocol on a socket rejected by close code', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject`, TOKEN_OFFER);
    rawSockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    expect(socket.protocol).toBe('livething-v1');
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('removes a client-supplied LiveThing client IP header', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`, {
      headers: { 'LiveThing-Client-IP': '198.51.100.99' },
    });
    rawSockets.push(socket);
    const connected = waitForRawMessage(socket);

    await waitForOpen(socket);
    await expect(connected).resolves.toEqual([
      'connected',
      { clientIp: null, userId: 'lobby' },
      null,
    ]);
  });

  async function openLobbySocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/lobby`);
    rawSockets.push(socket);
    const connected = waitForRawMessage(socket);
    await waitForOpen(socket);
    await connected;

    return socket;
  }

  it('hands a binary frame to the engine as a plain Uint8Array, which closes it with 1003', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);

    const echoed = waitForRawMessage(socket);
    socket.send(JSON.stringify(['echo', { text: 'text' }, null]));
    await expect(echoed).resolves.toEqual(['echoed', { text: 'text' }, null]);

    const closed = waitForClose(socket);
    socket.send(Buffer.from([1, 2, 3]));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: '[livething] this server does not use binary()',
    });
    const [received] = capturedBridges.at(-1)!.binaryMessages;
    expect(Object.getPrototypeOf(received)).toBe(Uint8Array.prototype);
    expect([...received!]).toEqual([1, 2, 3]);
    await vi.waitFor(() => expect(lastDisconnect?.code).toBe(1003));
  });

  it('drops the socket with no close handshake on terminate', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);
    const closed = waitForClose(socket);

    capturedBridges.at(-1)!.transport.terminate!();

    await expect(closed).resolves.toMatchObject({ code: 1006 });
  });

  it('compresses outgoing messages when CrossWS turns on perMessageDeflate', async () => {
    const app = await createTestApp(definition, { perMessageDeflate: true });
    apps.push(app);
    const socket = await openLobbySocket(app.port);
    const tcp = (socket as WebSocket & { _socket: { bytesRead: number } })._socket;

    expect(socket.extensions).toBe('permessage-deflate');
    const before = tcp.bytesRead;
    const message = nextRawMessage(socket);
    capturedBridges.at(-1)!.transport.send({ kind: 'text', text: 'x'.repeat(2000) });
    await message;

    expect(tcp.bytesRead - before).toBeLessThan(200);
  });

  it('sends a bytes frame as a binary message', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);

    const message = nextRawMessage(socket);
    capturedBridges.at(-1)!.transport.send({ kind: 'bytes', bytes: new Uint8Array([7, 8, 9]) });
    const { data, isBinary } = await message;

    expect(isBinary).toBe(true);
    expect([...(data as Buffer)]).toEqual([7, 8, 9]);
  });

  it('returns an HTTP rejection before the WebSocket handshake', async () => {
    const app = await createTestApp();
    apps.push(app);

    const response = await sendUpgrade(app.port, '/ws/http-reject');

    expect(response).toContain('HTTP/1.1 401');
    expect(response).toContain('No token');
    expect(response).not.toMatch(/^content-type:/im);
  });

  it('answers a plain HTTP request with 426 without running authenticate', async () => {
    const authenticate = vi.fn(() => ({ userId: 'plain' }));
    const app = await createTestApp(
      createServerDefinition({ authenticate }).assemble({ handlers: [] }),
    );
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${app.port}/ws/lobby`);
    expect(response.status).toBe(426);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('does not run authenticate for a non-WebSocket upgrade request', async () => {
    const authenticate = vi.fn(() => ({ userId: 'plain' }));
    const app = await createTestApp(
      createServerDefinition({ authenticate }).assemble({ handlers: [] }),
    );
    apps.push(app);

    const response = await sendNonWebSocketUpgrade(app.port, '/ws/lobby');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed upgrade URL', async () => {
    const { hooks, livething } = captureAuthHook(definition);

    const response = await hooks.upgrade?.({
      context: {},
      headers: new Headers({ host: 'example.test', upgrade: 'websocket' }),
      url: 'http://example.test/ws\\lobby',
    });

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(400);
    await expect(response?.text()).resolves.toBe('Invalid upgrade request');
    await livething.shutdown();
  });

  it('returns 500 when endpoint startup prevents upgrade preparation', async () => {
    const invalidDefinition = createServerDefinition({}).assemble({
      handlers: [],
      api: () => ({ then() {} }),
    });
    const { hooks, livething } = captureAuthHook(invalidDefinition);

    const response = await hooks.upgrade?.({
      context: {},
      headers: new Headers({ host: 'example.test', upgrade: 'websocket' }),
      url: 'http://example.test/ws/lobby',
    });

    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(500);
    await expect(response?.text()).resolves.toBe('Upgrade preparation failed');
    await expect(livething.shutdown()).rejects.toThrow();
  });

  it('closes a socket-level rejection after the handshake', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject`);
    rawSockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);

    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  it('passes the client close code and reason to onDisconnect', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    rawSockets.push(socket);
    const connected = waitForRawMessage(socket);

    await waitForOpen(socket);
    await connected;

    socket.close(4000, 'client finished');

    await vi.waitFor(() =>
      expect(lastDisconnect).toEqual({ code: 4000, reason: 'client finished' }),
    );
  });

  it('trims a long socket rejection reason to the control-frame limit', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject-long`);
    rawSockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);

    await expect(closed).resolves.toEqual({ code: 4001, reason: '🙂'.repeat(30) });
  });

  it('closes with an internal error when connection setup fails', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/accept-failure`);
    rawSockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);

    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: '[livething] connection setup failed',
    });
  });

  it('rejects client IP configuration that H3 v1 cannot apply safely', async () => {
    const livething = createH3V1Setup(defineWebSocketHandler);

    expect(() =>
      livething.bind(definition, {
        clientIp: { mode: 'direct' },
      } as never),
    ).toThrow('[livething] H3 v1 does not expose the Node client IP');

    await livething.shutdown();
  });

  it('aborts pending upgrade work during shutdown and waits for it to settle', async () => {
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
      async authenticate(request) {
        started();
        request.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await releaseUpgrade;
        return { userId: 'slow' };
      },
    }).assemble({ handlers: [] });
    const app = await createTestApp(slowDefinition);
    apps.push(app);

    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow`);
    rawSockets.push(socket);
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
      await expect(sendUpgrade(app.port, '/ws/second')).resolves.toContain('HTTP/1.1 503');
    } finally {
      release();
    }

    await shutdown;
  });

  it('cleans up a connection when the client leaves during upgrade work', async () => {
    let release!: () => void;
    let started!: () => void;
    let connections = 0;
    let disconnections = 0;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });

    const releaseUpgrade = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createServerDefinition({
      async authenticate() {
        started();
        await releaseUpgrade;
        return { userId: 'gone' };
      },
      onConnect() {
        connections += 1;
      },
      onDisconnect() {
        disconnections += 1;
      },
    });

    const app = await createTestApp(slow.assemble({ handlers: [] }));
    apps.push(app);

    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow`);
    rawSockets.push(socket);
    socket.on('error', () => {});

    await startedUpgrade;
    socket.terminate();
    release();

    await vi.waitFor(() => expect(disconnections).toBe(1));
    expect(connections).toBe(1);
  });

  it('rejects upgrades that arrive after shutdown starts', async () => {
    const app = await createTestApp();
    apps.push(app);

    await app.livething.shutdown();

    await expect(sendUpgrade(app.port, '/ws/lobby')).resolves.toContain('HTTP/1.1 503');
  });

  it('closes connected clients with going-away during shutdown', async () => {
    const app = await createTestApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`);
    rawSockets.push(socket);
    const connected = waitForRawMessage(socket);

    await waitForOpen(socket);
    await connected;
    const closed = waitForClose(socket);

    await app.livething.shutdown();

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(lastDisconnect).toEqual({ code: 1001, reason: 'Server shutting down' });
  });

  it('reports the real outbound queue while an H3 v1 client is slow', async () => {
    const queued = createServerDefinition({
      authenticate() {
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
    const app = await createTestApp(queued.assemble({ handlers: [fillQueue] }));
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow-client`);

    rawSockets.push(socket);
    await waitForOpen(socket);

    const queuedAmount = new Promise<number>((resolve, reject) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as [string, unknown, unknown];
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

  it('keeps the connection until close after a transport error', async () => {
    const app = await createTestApp();
    apps.push(app);

    await sendInvalidClientFrame(app.port, '/ws/lobby');

    await vi.waitFor(() => expect(disconnects).toBe(1));
    expect(transportErrors).toBeGreaterThan(0);
  });
});
