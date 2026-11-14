import websocketPlugin from '@fastify/websocket';
import { createAdaptorServer } from '@hono/node-server';
import { client, sse as clientSse, connect } from '@livething/client';
import { emits, server, t } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import Fastify from 'fastify';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferClient } from '@livething/server';
import type { ServerTransport } from '@livething/server/adapters';
import { sse } from '../index.ts';
import { setup as setupFastify } from './fastify/index.ts';
import { setup as setupHono } from './hono/index.ts';

const base = server({
  authenticate: (request) => ({ userId: new URL(request.url).searchParams.get('user') ?? 'ama' }),
  capabilities: [
    keepalive({ pingIntervalMs: 200, idleTimeoutMs: 600 }),
    emits({ messageCreated: t<{ text: string; by: string }>() }),
  ],
});

const handleSendMessage = base.on('sendMessage', {
  run(ctx, input) {
    ctx.send('messageCreated', { text: (input as { text: string }).text, by: ctx.user.id });
  },
});

const huddleDefinition = base.assemble({ handlers: [handleSendMessage] });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Connects the real client over SSE, sends one message and waits for the answer. */
async function roundTrip(url: string): Promise<string[]> {
  const socket = client<InferClient<typeof huddleDefinition>>()(
    connect(`${url}?user=kofi`, { transports: [clientSse()] }),
  );
  socket.onError(() => {});
  const received: string[] = [];
  socket.on('messageCreated', (message) => received.push(`${message.by}:${message.text}`));
  socket.connect();

  await vi.waitFor(() => expect(socket.state.get()).toBe('open'));

  socket.send('sendMessage', { text: 'hello' });
  await vi.waitFor(() => expect(received).toHaveLength(1));
  // Quiet for a few pings, so the pongs went up the control lane too.
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(socket.state.get()).toBe('open');
  socket.disconnect();

  return received;
}

describe('server-sent events through the framework helpers', () => {
  it('works on Hono, with handle mounted on the endpoint path', async () => {
    const app = new Hono();
    const livething = setupHono();
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [sse()] });
    app.all('/huddle', huddleEndpoint.handle);
    const http = createAdaptorServer({ fetch: app.fetch, websocket: livething.websocket });

    await livething.ready();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      await livething.shutdown();
      await new Promise((resolve) => http.close(resolve));
    });
    const { port } = http.address() as { port: number };

    expect(await roundTrip(`http://127.0.0.1:${port}/huddle`)).toEqual(['kofi:hello']);
  });

  it('works on Fastify, with connect on GET and handle on POST and OPTIONS', async () => {
    const app = Fastify();
    await app.register(websocketPlugin);
    const livething = setupFastify();
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [sse()] });
    app.get('/huddle', huddleEndpoint.connect);

    app.route({ method: ['POST', 'OPTIONS'], url: '/huddle', ...huddleEndpoint.handle });
    await livething.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(async () => {
      await livething.shutdown();
      await app.close();
    });
    const { port } = app.server.address() as { port: number };

    expect(await roundTrip(`http://127.0.0.1:${port}/huddle`)).toEqual(['kofi:hello']);
  });

  it('answers a plain GET on Fastify with 426 when sse() is not listed', async () => {
    const app = Fastify();
    await app.register(websocketPlugin);
    const livething = setupFastify();
    app.get('/huddle', livething.bind(huddleDefinition, {}).connect);
    await app.listen({ host: '127.0.0.1', port: 0 });

    cleanups.push(async () => {
      await livething.shutdown();
      await app.close();
    });
    const { port } = app.server.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${port}/huddle`);

    expect(response.status).toBe(426);
  });
});

/** A custom transport that holds every request until its signal aborts. */
function heldTransport(): ServerTransport {
  return {
    name: 'held',
    async handle(request) {
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
      return new Response(null, { status: 204 });
    },
  };
}

describe('shutdown with a custom transport that holds a request', () => {
  it('ends the held request on Hono', async () => {
    const app = new Hono();
    const livething = setupHono();
    app.all('/huddle', livething.bind(huddleDefinition, { transports: [heldTransport()] }).handle);
    const http = createAdaptorServer({ fetch: app.fetch, websocket: livething.websocket });
    await livething.ready();

    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };
    const held = fetch(`http://127.0.0.1:${port}/huddle`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await livething.shutdown();

    expect(await held).toBeInstanceOf(Error);
    await new Promise((resolve) => http.close(resolve));
  }, 5000);

  it('ends the held request on Fastify', async () => {
    const app = Fastify();
    await app.register(websocketPlugin);
    const livething = setupFastify();
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [heldTransport()] });
    app.get('/huddle', huddleEndpoint.connect);

    await livething.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const held = fetch(`http://127.0.0.1:${port}/huddle`).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await livething.shutdown();

    expect(await held).toBeInstanceOf(Error);
    await app.close();
  }, 5000);
});
