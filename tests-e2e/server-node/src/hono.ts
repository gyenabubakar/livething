import { createAdaptorServer } from '@hono/node-server';
import { setup } from '@livething/server-node/hono';
import { Hono } from 'hono';
import type { HonoEndpoint } from '@livething/server-node/hono';
import type { Server } from 'node:http';
import { configureFixtureBinding, getFixture, handleFetchRequest, listen } from './node-http.ts';

const transport = setup();
configureFixtureBinding((definition, options) => {
  const livething = setup();
  const endpoint = livething.bind(definition, options);
  return {
    endpoint,
    ready: endpoint.ready(),
    keepAlive: true,
    admin: endpoint.admin,
    shutdown: livething.shutdown,
  };
});

const app = new Hono();
app.get('/ws/*', async (context, next) => {
  if (context.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return handleFetchRequest(context.req.raw);
  }

  const url = new URL(context.req.url);
  const room = url.searchParams.get('room') ?? 'default';
  const fixture = await getFixture(url.pathname, room);
  const endpoint = fixture.service.endpoint as HonoEndpoint;

  return endpoint.upgrade(context, next);
});
app.all('*', async (context) => {
  return handleFetchRequest(context.req.raw);
});

const server = createAdaptorServer({ fetch: app.fetch, websocket: transport.websocket }) as Server;
listen(server, 'Hono');
