import { setup } from '@wskit/server-node/h3';
import { serve } from 'crossws/server/node';
import { H3 } from 'h3/node';
import type { H3Endpoint } from '@wskit/server-node/h3';
import { configureFixtureBinding, getFixture, handleFetchRequest } from './node-http.ts';

configureFixtureBinding((definition, options) => {
  const wskit = setup();
  const endpoint = wskit.bind(definition, options);
  return {
    endpoint,
    ready: endpoint.ready(),
    keepAlive: true,
    admin: endpoint.admin,
    shutdown: wskit.shutdown,
  };
});

const app = new H3();
app.get('/ws/**', async (event) => {
  if (event.req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return handleFetchRequest(event.req);
  }

  const url = new URL(event.req.url);
  const room = url.searchParams.get('room') ?? 'default';
  const fixture = await getFixture(url.pathname, room);
  const endpoint = fixture.service.endpoint as H3Endpoint;

  return endpoint.upgrade(event);
});
app.all('/**', (event) => handleFetchRequest(event.req));

const port = Number(process.env.WSKIT_E2E_SERVER_PORT ?? 8787);
const served = serve({ fetch: app.fetch, hostname: '127.0.0.1', port, websocket: {} });
const server = served.node?.server;
if (!server) throw new Error('Expected an H3 Node server');
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
console.log(`WSKit H3 e2e server listening on 127.0.0.1:${port}`);
