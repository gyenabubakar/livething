import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttp2Server, connect as http2Connect } from 'node:http2';
import {
  client,
  binary as clientBinary,
  dedup as clientDedup,
  reconnection as clientReconnection,
  replay as clientReplay,
  sse as clientSse,
  websocket as clientWebsocket,
  connect,
} from '@livething/client';
import { emits, server, t } from '@livething/server';
import { binary } from '@livething/server/binary';
import { dedup } from '@livething/server/dedup';
import { RejectAuth } from '@livething/server/errors';
import { keepalive } from '@livething/server/keepalive';
import { replay } from '@livething/server/replay';
import { sequence } from '@livething/server/sequence';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferClient } from '@livething/server';
import type { ServerDefinition } from '@livething/server/adapters';
import type { IncomingMessage, Server, ServerOptions } from 'node:http';
import type { Duplex } from 'node:stream';
import { sse, websocket } from './index.ts';
import { setup } from './setup.ts';
import type { NodeServerEndpointOptions } from './setup.ts';

const disconnects: { code: number | undefined; reason: string | undefined }[] = [];

const base = server({
  authenticate(request) {
    const url = new URL(request.url);
    if (url.searchParams.has('banned')) throw RejectAuth(4009, 'Banned from Huddle');

    if (url.searchParams.has('expired')) throw RejectAuth(401, 'Log in again');

    const bearer = request.headers.get('authorization');

    return { userId: bearer?.slice('Bearer '.length) ?? url.searchParams.get('user') ?? 'ama' };
  },
  capabilities: [
    keepalive({ pingIntervalMs: 200, idleTimeoutMs: 600 }),
    binary({ emits: { 'avatar-preview': t<{ size: number }>() } }),
    emits({
      messageCreated: t<{ text: string; by: string }>(),
      historyPage: t<{ page: number; text: string }>(),
    }),
  ],
  onDisconnect(ctx) {
    disconnects.push({ code: ctx.closeCode, reason: ctx.closeReason });
  },
});

const handleSendMessage = base.on('sendMessage', {
  async run(ctx, input) {
    // Slow enough that a burst of messages fills the connection's queue.
    await new Promise((resolve) => setTimeout(resolve, 2));
    ctx.send('messageCreated', { text: (input as { text: string }).text, by: ctx.user.id });
  },
});

const handleLeaveHuddle = base.on('leaveHuddle', {
  run(ctx) {
    ctx.close(4000, 'left the huddle');
  },
});

const handleUploadAvatar = base.binary.on('upload-avatar', {
  run(ctx, _input, bytes) {
    ctx.binary.send('avatar-preview', bytes.subarray(0, 8), { info: { size: bytes.byteLength } });
  },
});

// Sends the whole message history at once, far more than a client that stopped reading takes.
const handleLoadHistory = base.on('loadHistory', {
  run(ctx) {
    for (let page = 0; page < 400; page++) {
      ctx.send('historyPage', { page, text: 'x'.repeat(30 * 1024) });
    }
  },
});

const huddleDefinition = base.assemble({
  handlers: [handleSendMessage, handleLeaveHuddle, handleUploadAvatar, handleLoadHistory],
});

type HuddleClient = InferClient<typeof huddleDefinition>;

let running: { http: Server; shutdown(): Promise<void> } | null = null;
let admin: () => Promise<{ broadcast(event: string, payload: unknown): void }>;

afterEach(async () => {
  await running?.shutdown();
  running = null;
  disconnects.length = 0;
});

async function start(
  options: NodeServerEndpointOptions = { transports: [sse()] },
  serverOptions: ServerOptions = {},
  definition: ServerDefinition = huddleDefinition,
) {
  const livething = setup();
  const huddleEndpoint = livething.bind(definition, options);
  admin = huddleEndpoint.admin as () => Promise<{
    broadcast(event: string, payload: unknown): void;
  }>;
  const http = createServer(serverOptions, (request, response) => {
    if (new URL(request.url ?? '/', 'http://x').pathname === '/huddle') {
      huddleEndpoint.handle(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  http.on('upgrade', huddleEndpoint.upgrade);

  await huddleEndpoint.ready();

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as { port: number };
  running = {
    http,
    async shutdown() {
      await livething.shutdown();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };

  return `http://127.0.0.1:${port}/huddle`;
}

function open(url: string, token?: string) {
  const socket = client<HuddleClient>()(
    connect(url, { transports: [clientSse()], ...(token ? { token: () => token } : {}) }),
    clientBinary(),
  );
  const closes: { code: number; reason: string }[] = [];
  socket.onClose((event) => closes.push({ code: event.code, reason: event.reason }));
  socket.onError(() => {});
  socket.connect();

  return { socket, closes };
}

describe('server-sent events on Node', () => {
  it('connects, and carries messages both ways in order', async () => {
    const url = await start();
    const { socket } = open(url, 'kofi');
    const received: string[] = [];
    socket.on('messageCreated', (message) => received.push(`${message.by}:${message.text}`));

    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));
    expect(socket.transport.get()).toBe('sse');
    expect(socket.ws).toBeNull();
    for (let i = 0; i < 600; i++) socket.send('sendMessage', { text: String(i) });

    await vi.waitFor(() => expect(received).toHaveLength(600), { timeout: 10_000 });
    expect(received).toEqual(Array.from({ length: 600 }, (_, i) => `kofi:${i}`));
    socket.disconnect();
  });

  it('carries binary frames both ways', async () => {
    const url = await start();
    const { socket } = open(url);
    const previews: number[][] = [];
    socket.binary.on('avatar-preview', (_info, bytes) => previews.push([...bytes]));
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.binary.send(
      'upload-avatar',
      Uint8Array.from({ length: 1000 }, (_, i) => i % 256),
      { info: null },
    );

    await vi.waitFor(() => expect(previews).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]));
    socket.disconnect();
  });

  it("gives the client the server's close code and reason", async () => {
    const url = await start();
    const { socket, closes } = open(url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.send('leaveHuddle', undefined);

    await vi.waitFor(() => expect(closes).toEqual([{ code: 4000, reason: 'left the huddle' }]));
    await vi.waitFor(() =>
      expect(disconnects).toEqual([{ code: 4000, reason: 'left the huddle' }]),
    );
  });

  it("gives the server the client's close code and reason", async () => {
    const url = await start();
    const { socket } = open(url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.disconnect(4100, 'tab closed');

    await vi.waitFor(() => expect(disconnects).toEqual([{ code: 4100, reason: 'tab closed' }]));
  });

  it('keeps a quiet connection open with pings and pongs', async () => {
    const url = await start();
    const { socket, closes } = open(url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(socket.state.get()).toBe('open');
    expect(closes).toEqual([]);
    socket.disconnect();
  });

  it('reports a reject by close code as that close, with no open', async () => {
    const url = await start();
    const { socket, closes } = open(`${url}?banned`);
    const states: string[] = [];
    socket.state.subscribe((state) => states.push(state));

    await vi.waitFor(() => expect(closes).toEqual([{ code: 4009, reason: 'Banned from Huddle' }]));
    expect(states).not.toContain('open');
  });

  it('reports an HTTP 401 from authenticate as AUTH_EXPIRED', async () => {
    const url = await start();
    const { closes } = open(`${url}?expired`);

    await vi.waitFor(() => expect(closes).toEqual([{ code: 4001, reason: 'Log in again' }]));
  });

  it('refuses a message over maxPostBytes before it sends anything', async () => {
    const url = await start({ transports: [sse({ maxPostBytes: 300 * 1024 })] });
    const { socket } = open(url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    expect(() => socket.send('sendMessage', { text: 'x'.repeat(300 * 1024) })).toThrow(
      /over the server's POST limit/,
    );
    expect(socket.state.get()).toBe('open');
    socket.disconnect();
  });
});

describe('the transports option on Node', () => {
  it('answers a WebSocket upgrade with 404 when websocket() is not listed', async () => {
    const url = await start({ transports: [sse()] });

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      request.on('response', (response) => resolve(response.statusCode));
      request.on('upgrade', () => resolve(101));
      request.on('error', reject);
      request.end();
    });

    expect(status).toBe(404);
  });

  it('answers a stream request with 426 when sse() is not listed', async () => {
    const url = await start({ transports: [websocket()] });

    const response = await fetch(url, { headers: { Accept: 'text/event-stream' } });

    expect(response.status).toBe(426);
    expect(response.headers.get('LiveThing-Error')).toBe('not-offered');
  });

  it('refuses sse() at bind() when the definition has no keepalive()', () => {
    const plain = server({}).assemble({ handlers: [] });

    expect(() => setup().bind(plain, { transports: [sse()] })).toThrow(/needs keepalive\(\)/);
  });
});

describe('POSTs on Node', () => {
  it('answers 404 to a POST whose secret it does not know', async () => {
    const url = await start();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'LiveThing-Secret': 'nope', 'LiveThing-Lane': 'data' },
      body: new Uint8Array(0),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('LiveThing-Error')).toBe('unknown-connection');
  });

  it('answers 413 to a body over maxPostBytes', async () => {
    const url = await start({ transports: [sse({ maxPostBytes: 1024 })] });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'LiveThing-Secret': 'nope', 'LiveThing-Lane': 'data' },
      body: new Uint8Array(2048),
    });

    expect(response.status).toBe(413);
  });
});

describe('CORS on Node', () => {
  const options = { transports: [sse()], allowedOrigins: ['https://app.huddle.test'] };

  it('answers a preflight from an allowed origin', async () => {
    const url = await start(options);

    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.huddle.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'livething-secret, livething-lane, content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.huddle.test');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('LiveThing-Secret');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
  });

  it('refuses another origin with 403 and no CORS headers', async () => {
    const url = await start(options);

    const response = await fetch(url, {
      headers: { Origin: 'https://evil.test', Accept: 'text/event-stream' },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('LiveThing-Error')).toBe('origin');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('marks the stream of an allowed origin readable cross-origin', async () => {
    const url = await start(options);
    const abort = new AbortController();

    const response = await fetch(url, {
      headers: { Origin: 'https://app.huddle.test', Accept: 'text/event-stream' },
      signal: abort.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.huddle.test');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('LiveThing-Error');
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
    abort.abort();
  });
});

/** A stream read by hand: the events so far, and the secret from its `__connected__` frame. */
async function rawStream(url: string) {
  const abort = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const events: string[] = [];
  const reader = response.body!.getReader();
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;

        buffer += new TextDecoder().decode(value);
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop()!;
        events.push(...blocks.map((block) => block.slice('data: '.length)));
      }
    } catch {}
  })();

  await vi.waitFor(() => expect(events[0]).toContain('__connected__'));
  const secret = (JSON.parse(events[0]!) as [string, { secret: string }])[1].secret;

  return { events, secret, abort: () => abort.abort() };
}

function textBatch(...texts: string[]): Buffer {
  return Buffer.concat(
    texts.map((text) => {
      const data = Buffer.from(text);
      const header = Buffer.alloc(5);
      header.writeUInt32BE(data.byteLength, 1);
      return Buffer.concat([header, data]);
    }),
  );
}

describe("Node's own server limits", () => {
  it('keeps a stream open past requestTimeout, and answers a slow POST body with 408', async () => {
    const url = await start(
      { transports: [sse()] },
      {
        requestTimeout: 1000,
        headersTimeout: 900,
        keepAliveTimeout: 500,
        connectionsCheckingInterval: 200,
      },
    );
    const { socket, closes } = open(url);
    const { secret, abort } = await rawStream(url);

    const status = await new Promise<number | undefined>((resolve) => {
      const request = httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Length': '100', 'LiveThing-Secret': secret, 'LiveThing-Lane': 'data' },
      });
      request.on('response', (response) => resolve(response.statusCode));
      request.on('error', () => resolve(undefined));
      request.write('x');
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(status).toBe(408);
    expect(socket.state.get()).toBe('open');
    expect(closes).toEqual([]);
    socket.disconnect();
    abort();
  });
});

describe('a client that stops reading its stream', () => {
  it('is closed with 1013 once its buffer stayed over twice maxMessageBytes for 10 seconds', async () => {
    const url = await start({
      transports: [sse({ maxPostBytes: 16 * 1024 })],
      maxMessageBytes: 64 * 1024,
    });
    const abort = new AbortController();
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    });
    // Read only the `__connected__` frame, then stop reading.
    const reader = response.body!.getReader();
    let first = '';
    while (!first.includes('\n\n')) first += new TextDecoder().decode((await reader.read()).value);
    const secret = (JSON.parse(first.slice('data: '.length)) as [string, { secret: string }])[1]
      .secret;

    const answer = await fetch(url, {
      method: 'POST',
      headers: { 'LiveThing-Secret': secret, 'LiveThing-Lane': 'data' },
      body: textBatch(JSON.stringify(['loadHistory', null, null])),
    });
    expect(answer.status).toBe(204);
    // Pongs go up on their own lane, so the server never sees the client as idle.
    const pongs = setInterval(() => {
      void fetch(url, {
        method: 'POST',
        headers: { 'LiveThing-Secret': secret, 'LiveThing-Lane': 'control' },
        body: textBatch('pong'),
      }).catch(() => {});
    }, 100);

    // The keepalive pings run the check while the buffer stays full.
    await vi.waitFor(() => expect(disconnects.map((close) => close.code)).toEqual([1013]), {
      timeout: 15_000,
      interval: 200,
    });
    clearInterval(pongs);
    abort.abort();
  }, 20_000);
});

describe('replay over server-sent events', () => {
  const replayBase = server({
    authenticate: () => ({ userId: 'kofi' }),
    capabilities: [
      keepalive({ pingIntervalMs: 200, idleTimeoutMs: 600 }),
      dedup(),
      sequence({ persist: true }),
      replay.history(),
      emits({ announcement: t<{ text: string }>() }),
    ],
  });
  const announcementsDefinition = replayBase.assemble({ handlers: [] });

  it('replays what a client missed while its stream was down, once', async () => {
    const url = await start({ transports: [sse()] }, {}, announcementsDefinition);
    const socket = client<InferClient<typeof announcementsDefinition>>()(
      connect(url, { transports: [clientSse()] }),
      clientReconnection({ maxDelay: 200 }),
      clientDedup(),
      clientReplay(),
    );
    socket.onError(() => {});
    const seen: string[] = [];
    socket.on('announcement', (message) => seen.push(message.text));

    socket.connect();
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));
    await (await admin()).broadcast('announcement', { text: 'standup at 10' });
    await vi.waitFor(() => expect(seen).toEqual(['standup at 10']));

    running!.http.closeAllConnections();
    await vi.waitFor(() => expect(socket.state.get()).not.toBe('open'));
    await (await admin()).broadcast('announcement', { text: 'standup moved to 11' });

    await vi.waitFor(() => expect(seen).toEqual(['standup at 10', 'standup moved to 11']));
    expect(socket.transport.get()).toBe('sse');
    socket.disconnect();
  });
});

describe('failover on Node', () => {
  it('moves to server-sent events when a proxy accepts the upgrade and passes nothing', async () => {
    const url = await start({ transports: [websocket(), sse()] });
    // The proxy: it answers the handshake, then never forwards a frame.
    running!.http.removeAllListeners('upgrade');
    const stalled: Duplex[] = [];
    running!.http.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
      stalled.push(socket);
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });

    const socket = client<HuddleClient>()(
      connect(url, {
        transports: [clientWebsocket(), clientSse()],
        token: () => 'kofi',
        connectTimeoutMs: 1_000,
      }),
      clientBinary(),
    );
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));
    const received: string[] = [];
    socket.on('messageCreated', (message) => received.push(message.text));

    socket.connect();
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'), { timeout: 5_000 });
    expect(socket.transport.get()).toBe('sse');
    // The app never heard about the stalled WebSocket.
    expect(errors).toEqual([]);

    socket.send('sendMessage', { text: 'standup at 10' });
    await vi.waitFor(() => expect(received).toEqual(['standup at 10']));
    socket.disconnect();
    // An upgraded socket has left the HTTP server, so its shutdown would wait for it.
    for (const proxied of stalled) proxied.destroy();
  });
});

describe('shutdown on Node', () => {
  it('closes an open stream with 1001 and a __close__ frame', async () => {
    const url = await start();
    const { socket, closes } = open(url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    await running!.shutdown();
    running = null;

    await vi.waitFor(() => expect(closes.map((close) => close.code)).toEqual([1001]));
  });
});

describe('HTTP/2 on Node', () => {
  it('serves the stream and its POSTs to a node:http2 compatibility server', async () => {
    const livething = setup();
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [sse()] });
    const h2 = createHttp2Server((request, response) => huddleEndpoint.handle(request, response));
    await huddleEndpoint.ready();
    await new Promise<void>((resolve) => h2.listen(0, '127.0.0.1', resolve));

    const { port } = h2.address() as { port: number };
    const session = http2Connect(`http://127.0.0.1:${port}`);
    running = {
      http: h2 as unknown as Server,
      async shutdown() {
        session.destroy();
        await livething.shutdown();
        await new Promise((resolve) => h2.close(resolve));
      },
    };

    const events: string[] = [];
    const stream = session.request({ ':path': '/huddle', accept: 'text/event-stream' });
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => events.push(...chunk.split('\n\n').filter(Boolean)));
    await vi.waitFor(() => expect(events[0]).toContain('__connected__'));

    const secret = (
      JSON.parse(events[0]!.slice('data: '.length)) as [string, { secret: string }]
    )[1].secret;

    const post = session.request({
      ':method': 'POST',
      ':path': '/huddle',
      'livething-secret': secret,
      'livething-lane': 'data',
      'content-type': 'application/octet-stream',
    });
    const status = new Promise((resolve) =>
      post.on('response', (headers) => resolve(headers[':status'])),
    );
    post.end(textBatch(JSON.stringify(['sendMessage', { text: 'over h2' }, null])));

    expect(await status).toBe(204);
    await vi.waitFor(() => expect(events.some((event) => event.includes('over h2'))).toBe(true));
    stream.close();
  });
});
