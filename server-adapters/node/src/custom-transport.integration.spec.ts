import { createServer } from 'node:http';
import { client, sse as clientSse, websocket as clientWebsocket, connect } from '@livething/client';
import { emits, server, t } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferClient } from '@livething/server';
import type { ServerTransport } from '@livething/server/adapters';
import { binding } from './binding.ts';
import { sse, websocket } from './index.ts';
import { longPollingClient, longPollingServer } from './long-polling.fixture.ts';
import { setup } from './setup.ts';
import type { NodeServerEndpointOptions } from './setup.ts';

const disconnects: { code: number | undefined; reason: string | undefined }[] = [];

const base = server({
  authenticate: (request) => ({ userId: new URL(request.url).searchParams.get('user') ?? 'ama' }),
  capabilities: [
    keepalive({ pingIntervalMs: 200, idleTimeoutMs: 600 }),
    emits({ messageCreated: t<{ text: string; by: string }>() }),
  ],
  onDisconnect(ctx) {
    disconnects.push({ code: ctx.closeCode, reason: ctx.closeReason });
  },
});

const handleSendMessage = base.on('sendMessage', {
  run(ctx, input) {
    ctx.send('messageCreated', { text: (input as { text: string }).text, by: ctx.user.id });
  },
});

const handleLeaveHuddle = base.on('leaveHuddle', {
  run(ctx) {
    ctx.close(4000, 'left the huddle');
  },
});

const huddleDefinition = base.assemble({ handlers: [handleSendMessage, handleLeaveHuddle] });

type HuddleClient = InferClient<typeof huddleDefinition>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();

  disconnects.length = 0;
});

async function start(options: NodeServerEndpointOptions) {
  const livething = setup();
  const huddleEndpoint = livething.bind(huddleDefinition, options);
  const http = createServer((request, response) => void huddleEndpoint.handle(request, response));
  http.on('upgrade', huddleEndpoint.upgrade);
  await huddleEndpoint.ready();

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await livething.shutdown();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });
  const { port } = http.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}/huddle`,
    admin: huddleEndpoint.admin as () => Promise<{
      broadcast(event: string, payload: unknown): void;
    }>,
  };
}

function open(url: string, transports = [longPollingClient()]) {
  const socket = client<HuddleClient>()(connect(`${url}?user=kofi`, { transports }));
  socket.onError(() => {});
  const received: string[] = [];
  socket.on('messageCreated', (message) => received.push(`${message.by}:${message.text}`));
  socket.connect();

  cleanups.unshift(async () => socket.disconnect());

  return { socket, received };
}

describe('a custom transport built on the public API', () => {
  it('carries messages both ways, and a broadcast reaches an idle poll', async () => {
    const huddle = await start({ transports: [longPollingServer({ pollMs: 300 })] });
    const { socket, received } = open(huddle.url);

    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));
    expect(socket.transport.get()).toBe('long-polling');

    socket.send('sendMessage', { text: 'hello' });
    await vi.waitFor(() => expect(received).toEqual(['kofi:hello']));

    // Quiet for many pings and polls, so pongs and empty polls both happened.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(socket.state.get()).toBe('open');

    (await huddle.admin()).broadcast('messageCreated', { text: 'standup in 5', by: 'esi' });
    await vi.waitFor(() => expect(received).toEqual(['kofi:hello', 'esi:standup in 5']));
  });

  it("gives the client the server's close code", async () => {
    const huddle = await start({ transports: [longPollingServer()] });
    const { socket } = open(huddle.url);
    const closes: number[] = [];
    socket.onClose((event) => closes.push(event.code));
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.send('leaveHuddle', {});

    await vi.waitFor(() => expect(closes).toContain(4000));
    await vi.waitFor(() =>
      expect(disconnects).toEqual([{ code: 4000, reason: 'left the huddle' }]),
    );
  });

  it('runs onDisconnect with the code of a client disconnect()', async () => {
    const huddle = await start({ transports: [longPollingServer()] });
    const { socket } = open(huddle.url);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.disconnect();

    await vi.waitFor(() => expect(disconnects).toEqual([{ code: 1000, reason: '' }]));
  });

  it('is a step in failover: a blocked WebSocket moves the client on to it', async () => {
    const huddle = await start({ transports: [longPollingServer()] });
    const { socket } = open(huddle.url, [clientWebsocket(), longPollingClient()]);

    await vi.waitFor(() => expect(socket.transport.get()).toBe('long-polling'));
  });

  it('runs the origin check before authenticate', async () => {
    const huddle = await start({ transports: [longPollingServer()] });

    const response = await fetch(huddle.url, {
      headers: { 'LiveThing-Transport': 'long-polling', Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
  });

  it('refuses to accept a rejected decision', async () => {
    const errors: unknown[] = [];
    const careless: ServerTransport = {
      name: 'careless',
      async handle(_request, endpoint) {
        try {
          endpoint.accept(
            {
              send: () => true,
              close: () => {},
              bufferedAmount: () => 0,
              backpressureSupported: false,
            },
            { reject: true, code: 401, reason: 'no session' },
          );
        } catch (error) {
          errors.push(error);
        }

        return new Response(null, { status: 204 });
      },
    };

    const huddle = await start({ transports: [careless] });

    await fetch(huddle.url);

    expect(String(errors[0])).toMatch(/rejected decision/);
  });

  it.each([{ frames: [null] }, { frames: 'ping' }, { close: { code: 1006, reason: '' } }])(
    'answers 400 to a long-polling POST of %j',
    async (body) => {
      const huddle = await start({ transports: [longPollingServer({ pollMs: 50 })] });
      const first = (await (
        await fetch(huddle.url, { headers: { 'LiveThing-Transport': 'long-polling' } })
      ).json()) as { frames: string[] };
      const { secret } = JSON.parse(first.frames[0]!)[1] as { secret: string };

      const response = await fetch(huddle.url, {
        method: 'POST',
        headers: { 'LiveThing-Transport': 'long-polling', 'LiveThing-Secret': secret },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
    },
  );

  it('answers 413 to a long-polling POST over 1 MiB', async () => {
    const huddle = await start({ transports: [longPollingServer({ pollMs: 50 })] });
    const first = (await (
      await fetch(huddle.url, { headers: { 'LiveThing-Transport': 'long-polling' } })
    ).json()) as { frames: string[] };
    const { secret } = JSON.parse(first.frames[0]!)[1] as { secret: string };

    const response = await fetch(huddle.url, {
      method: 'POST',
      headers: { 'LiveThing-Transport': 'long-polling', 'LiveThing-Secret': secret },
      body: JSON.stringify({ frames: ['x'.repeat(1024 * 1024)] }),
    });

    expect(response.status).toBe(413);
  });

  it('refuses a cross-site request with no Origin before authenticate', async () => {
    const huddle = await start({ transports: [longPollingServer()] });

    const response = await fetch(huddle.url, {
      headers: { 'LiveThing-Transport': 'long-polling', 'Sec-Fetch-Site': 'cross-site' },
    });

    expect(response.status).toBe(403);
  });

  it('passes a request it returns null for on to server-sent events, then to a 426', async () => {
    const seen: string[] = [];
    const audit: ServerTransport = {
      name: 'audit',
      async handle(request) {
        seen.push(request.method);
        return null;
      },
    };

    const withSse = await start({ transports: [audit, sse()] });
    const withoutSse = await start({ transports: [audit, websocket()] });

    const stream = await fetch(withSse.url, {
      headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
    });
    const plain = await fetch(withoutSse.url);

    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    await stream.body?.cancel();
    expect(plain.status).toBe(426);
    expect(seen).toEqual(['GET', 'GET']);
  });

  it('leaves the body unread for server-sent events when it returns null', async () => {
    const audit: ServerTransport = { name: 'audit', handle: async () => null };
    const huddle = await start({ transports: [audit, sse()] });
    const { socket, received } = open(huddle.url, [clientSse()]);
    await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

    socket.send('sendMessage', { text: 'hello' });

    await vi.waitFor(() => expect(received).toEqual(['kofi:hello']));
  });

  it('streams a response body as the transport writes it', async () => {
    const encoder = new TextEncoder();
    let push: ((text: string) => void) | null = null;
    const ticker: ServerTransport = {
      name: 'ticker',
      async handle() {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => controller.enqueue(encoder.encode(text));
          },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
      },
    };

    const huddle = await start({ transports: [ticker] });

    const response = await fetch(huddle.url);
    const reader = response.body!.getReader();
    push!('first');

    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    await reader.cancel();
  });

  it('shuts down while a transport holds a request, and its late answer is dropped', async () => {
    const livething = setup();
    const held: ServerTransport = {
      name: 'held',
      async handle(request) {
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
        return new Response('x'.repeat(1_000_000));
      },
    };

    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [held] });
    const http = createServer((request, response) => void huddleEndpoint.handle(request, response));
    await huddleEndpoint.ready();

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };
    const request = fetch(`http://127.0.0.1:${port}/huddle`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await livething.shutdown();

    expect(await request).toBeInstanceOf(Error);
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  });

  it('ends a held request when a bare binding shuts down', async () => {
    const node = binding();
    const held: ServerTransport = {
      name: 'held',
      async handle(request) {
        await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
        return new Response(null, { status: 204 });
      },
    };

    const huddleEndpoint = node.bind(huddleDefinition, { transports: [held] });
    const http = createServer(
      (request, response) => void huddleEndpoint.handleNode(request, response),
    );
    await huddleEndpoint.ready();

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };
    const request = fetch(`http://127.0.0.1:${port}/huddle`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await node.shutdown();

    expect(await request).toBeInstanceOf(Error);
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }, 5000);

  it('shuts down even when a handle() ignores the abort', async () => {
    const livething = setup();
    const stuck: ServerTransport = { name: 'stuck', handle: () => new Promise(() => {}) };
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [stuck] });
    const http = createServer((request, response) => void huddleEndpoint.handle(request, response));
    await huddleEndpoint.ready();

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };
    const request = fetch(`http://127.0.0.1:${port}/huddle`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await livething.shutdown();

    expect(await request).toBeInstanceOf(Error);
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }, 5000);

  it('reads a POST body', async () => {
    const bodies: string[] = [];
    const echo: ServerTransport = {
      name: 'echo',
      async handle(request) {
        bodies.push(await request.text());
        return new Response(null, { status: 204 });
      },
    };

    const huddle = await start({ transports: [echo] });

    const response = await fetch(huddle.url, { method: 'POST', body: 'x'.repeat(100_000) });

    expect(response.status).toBe(204);
    expect(bodies).toEqual(['x'.repeat(100_000)]);
  });
});
