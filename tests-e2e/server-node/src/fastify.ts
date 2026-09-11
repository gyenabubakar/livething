import websocket from '@fastify/websocket';
import { setup } from '@wskit/server-node/fastify';
import Fastify from 'fastify';
import type { FastifyEndpoint } from '@wskit/server-node/fastify';
import { configureFixtureBinding, getFixture, handleRequest } from './node-http.ts';

configureFixtureBinding((handler, options) => {
  const wskit = setup();
  const endpoint = wskit.bind(handler, options);
  return {
    endpoint,
    ready: endpoint.ready(),
    keepAlive: true,
    admin: endpoint.admin,
    shutdown: wskit.shutdown,
  };
});

const app = Fastify();
const endpoints = new WeakMap<object, FastifyEndpoint>();
await app.register(websocket);
const route: FastifyEndpoint['upgrade'] = {
  async preHandler(request, reply) {
    if (request.headers.upgrade?.toLowerCase() !== 'websocket') return;

    const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
    const room = url.searchParams.get('room') ?? 'default';
    const fixture = await getFixture(url.pathname, room);
    const endpoint = fixture.service.endpoint as FastifyEndpoint;
    endpoints.set(request.raw, endpoint);

    await endpoint.upgrade.preHandler(request, reply);
  },
  async handler(request, reply) {
    const endpoint = endpoints.get(request.raw);
    if (!endpoint) {
      await handleRequest(request.raw, reply.raw);
      return reply;
    }

    await endpoint.upgrade.handler(request, reply);
  },
  wsHandler(socket, request) {
    const endpoint = endpoints.get(request.raw);
    if (!endpoint) {
      socket.close(1011, 'Missing WSKit fixture');
      return;
    }

    endpoint.upgrade.wsHandler(socket, request);
  },
};

app.get('/ws/*', route);
app.all('*', async (request, reply) => {
  await handleRequest(request.raw, reply.raw);
  return reply;
});

const port = Number(process.env.WSKIT_E2E_SERVER_PORT ?? 8787);
await app.listen({ host: '127.0.0.1', port });
process.once('SIGINT', () => void app.close());
process.once('SIGTERM', () => void app.close());
console.log(`WSKit Fastify e2e server listening on 127.0.0.1:${port}`);
