import { connect as connectTcp } from 'node:net';
import websocket from '@fastify/websocket';
import { client, sse as clientSse, websocket as clientWebSocket, connect } from '@livething/client';
import { emits, server, t } from '@livething/server';
import { RejectAuth } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerDefinition } from '@livething/server/adapters';
import {
  capturedBridges,
  nextJsonMessage,
  nextRawMessage,
  openRawClient,
  rawTransport,
  rawTransportOptions,
} from '../../test-utils.ts';
import { setup } from './index.ts';
import type { NodeEndpointOptions } from '../../binding.ts';

/** A test of the WebSocket upgrade or of `ws` itself, which has no meaning over SSE. */
const wsOnly = it.skipIf(rawTransport === 'sse');

vi.mock('../../socket.ts', async (importOriginal) => {
  const { captureBridges } = await import('../../test-utils.ts');
  return captureBridges(await importOriginal());
});

let lastClientIp: string | null = null;
let lastAuthorization: string | null = null;
// What @livething/client offers for the token 'session-8f2c'.
const TOKEN_OFFER = [
  'livething-v1',
  `livething-v1.token.${Buffer.from('session-8f2c').toString('base64url')}`,
];
let disconnects = 0;
let lastDisconnect: { code: number; reason: string } | undefined;
let transportErrors = 0;

const base = server({
  authenticate(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/http-reject')) throw RejectAuth(401, 'No token');

    if (pathname.endsWith('/socket-reject')) throw RejectAuth(4001, 'No token');

    if (pathname.endsWith('/accept-failure')) return { userId: 'u'.repeat(257) };

    lastClientIp = request.headers.get('LiveThing-Client-IP');
    lastAuthorization = request.headers.get('authorization');

    return { userId: pathname.split('/').at(-1) ?? 'anonymous' };
  },
  capabilities: [
    keepalive(),
    emits({
      connected: t<{ clientIp: string | null }>(),
      echoed: t<{ text?: string }>(),
    }),
  ],
  onConnect(ctx) {
    ctx.send('connected', { clientIp: lastClientIp });
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
  run(ctx, input) {
    const text = (input as { text?: unknown } | null)?.text;
    ctx.send('echoed', typeof text === 'string' ? { text } : {});
  },
});

const assembled = base.assemble({ handlers: [echo] });

interface TestClient {
  incoming: {
    connected: { clientIp: string | null };
    echoed: { text?: string };
  };
  outgoing: { echo: { text: string } };
}

type WireFrame = readonly [event: string, payload: unknown, metadata: null];

async function createApp(
  options: Pick<NodeEndpointOptions, 'clientIp'> = {},
  definition: ServerDefinition = assembled,
) {
  const app = Fastify();
  await app.register(websocket);
  const livething = setup();
  const endpoint = livething.bind(definition, { ...rawTransportOptions, ...options });
  app.get('/ws/:room', endpoint.connect);

  app.route({ method: ['POST', 'OPTIONS'], url: '/ws/:room', ...endpoint.handle });

  await livething.ready();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

  return {
    app,
    port: address.port,
    livething,
    shutdown: async () => {
      await livething.shutdown();
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

function waitForMessage(socket: WebSocket): Promise<WireFrame> {
  return nextJsonMessage<WireFrame>(socket);
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function sendUpgrade(port: number, path: string, upgradeHeader = 'websocket'): Promise<string> {
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
          `Upgrade: ${upgradeHeader}`,
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

function getClientSocket(socket: WebSocket): { pause(): void; resume(): void } {
  const clientSocket = (
    socket as WebSocket & {
      _socket?: { pause(): void; resume(): void };
    }
  )._socket;

  if (!clientSocket) throw new Error('Expected the WebSocket client to have a TCP socket');

  return clientSocket;
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

describe('Fastify binding', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(apps.splice(0).map((app) => app.shutdown()));
    disconnects = 0;
    lastDisconnect = undefined;
    transportErrors = 0;
  });

  async function openLobbySocket(port: number): Promise<WebSocket> {
    const socket = openRawClient(`ws://127.0.0.1:${port}/ws/lobby`);
    sockets.push(socket);
    const connected = waitForMessage(socket);
    await waitForOpen(socket);
    await connected;

    return socket;
  }

  wsOnly('uses Fastify route parameters and forwards messages through LiveThing', async () => {
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

  wsOnly('answers the token subprotocol and passes the token to authenticate', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/lobby`, TOKEN_OFFER);
    sockets.push(socket);

    await waitForOpen(socket);
    expect(socket.protocol).toBe('livething-v1');
    expect(lastAuthorization).toBe('Bearer session-8f2c');
  });

  wsOnly('answers the token subprotocol on a socket rejected by close code', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject`, TOKEN_OFFER);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    expect(socket.protocol).toBe('livething-v1');
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  wsOnly('applies the endpoint client IP configuration to the Node request', async () => {
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

  wsOnly('derives the client IP through a trusted proxy before Fastify upgrades', async () => {
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

  wsOnly('cancels a pending upgrade before shutdown', async () => {
    let release!: () => void;
    let started!: () => void;
    let aborted = false;
    const startedUpgrade = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releaseUpgrade = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slowDefinition = server({
      async authenticate(request) {
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

  wsOnly('drops upgrades that arrive after LiveThing shutdown starts', async () => {
    const app = await createApp();
    apps.push(app);

    await app.livething.shutdown();

    await expect(sendOpenUpgrade(app.port, '/ws/lobby')).resolves.toBe('');
  });

  wsOnly('rejects before upgrade through Fastify preHandler', async () => {
    const app = await createApp();
    apps.push(app);

    const response = await sendUpgrade(app.port, '/ws/http-reject');
    expect(response).toContain('HTTP/1.1 401');
    expect(response).toMatch(/^content-type: text\/plain/im);
    expect(response).toContain('No token');
  });

  wsOnly('answers a plain HTTP request with 426 without running authenticate', async () => {
    const authenticate = vi.fn(() => ({ userId: 'plain' }));
    const app = await createApp({}, server({ authenticate }).assemble({ handlers: [] }));
    apps.push(app);

    const response = await fetch(`http://127.0.0.1:${app.port}/ws/lobby`);
    expect(response.status).toBe(426);
    expect(await response.text()).toBe('Upgrade Required');
    expect(authenticate).not.toHaveBeenCalled();
  });

  wsOnly('does not run authenticate for a non-WebSocket upgrade request', async () => {
    const authenticate = vi.fn(() => ({ userId: 'plain' }));
    const app = await createApp({}, server({ authenticate }).assemble({ handlers: [] }));
    apps.push(app);

    const response = await sendUpgrade(app.port, '/ws/lobby', 'h2c');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(authenticate).not.toHaveBeenCalled();
  });

  wsOnly('closes a socket-level rejection after Fastify upgrades it', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/socket-reject`);
    sockets.push(socket);
    const closed = waitForClose(socket);

    await waitForOpen(socket);
    await expect(closed).resolves.toEqual({ code: 4001, reason: 'No token' });
  });

  wsOnly('closes with an internal error when connection setup fails after upgrade', async () => {
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

  it('works with the LiveThing client', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = client<TestClient>()(
      connect(`ws://127.0.0.1:${app.port}/ws/lobby`, {
        transports: [rawTransport === 'sse' ? clientSse() : clientWebSocket()],
      }),
    );
    const connected = new Promise<{ clientIp: string | null }>((resolve) =>
      socket.on('connected', resolve),
    );
    const echoed = new Promise<{ text?: string }>((resolve) => socket.on('echoed', resolve));

    try {
      socket.connect();

      await expect(connected).resolves.toEqual({ clientIp: null });
      expect(socket.send('echo', { text: 'hello' })).toBe(true);
      await expect(echoed).resolves.toEqual({ text: 'hello' });
    } finally {
      socket.disconnect();
    }
  });

  it('hands a binary frame to the engine as a plain Uint8Array, which closes it with 1003', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);

    const echoed = waitForMessage(socket);
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
    const app = await createApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);
    const closed = waitForClose(socket);

    capturedBridges.at(-1)!.transport.terminate!();

    await expect(closed).resolves.toMatchObject({ code: 1006 });
  });

  it('sends a bytes frame as a binary message', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);

    const message = nextRawMessage(socket);
    capturedBridges.at(-1)!.transport.send({ kind: 'bytes', bytes: new Uint8Array([7, 8, 9]) });
    const { data, isBinary } = await message;

    expect(isBinary).toBe(true);
    expect([...(data as Buffer)]).toEqual([7, 8, 9]);
  });

  it('passes the client close code and reason to onDisconnect', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);

    socket.close(4000, 'client finished');

    await vi.waitFor(() =>
      expect(lastDisconnect).toEqual({ code: 4000, reason: 'client finished' }),
    );
  });

  it('closes connected clients with going-away during shutdown', async () => {
    const app = await createApp();
    apps.push(app);
    const socket = await openLobbySocket(app.port);
    const closed = waitForClose(socket);

    await app.livething.shutdown();

    await expect(closed).resolves.toEqual({ code: 1001, reason: 'Server shutting down' });
    expect(lastDisconnect).toEqual({ code: 1001, reason: 'Server shutting down' });
  });

  wsOnly('reports the real outbound queue while a Fastify client is slow', async () => {
    const queued = server({
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
    const app = await createApp({}, queued.assemble({ handlers: [fillQueue] }));
    apps.push(app);
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws/slow-client`);

    sockets.push(socket);
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

  wsOnly('keeps the connection until close after a transport error', async () => {
    const app = await createApp();
    apps.push(app);

    await sendInvalidClientFrame(app.port, '/ws/lobby');

    await vi.waitFor(() => expect(disconnects).toBe(1));
    expect(transportErrors).toBeGreaterThan(0);
  });
});
