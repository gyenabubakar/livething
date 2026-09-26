import { createServer } from 'node:http';
import { setup } from '@livething/server-node/h3/v1';
import nodeWebSocketAdapter from 'crossws-v1/adapters/node';
import { createApp, createRouter, toNodeListener, toWebRequest } from 'h3-v1';
import type { H3V1Endpoint } from '@livething/server-node/h3/v1';
import { configureFixtureBinding, getFixture, handleFetchRequest } from './node-http.ts';

configureFixtureBinding((definition, options) => {
  const livething = setup();
  // H3 v1 cannot read the client IP, and no fixture asks for it.
  const endpoint = livething.bind(definition, { ...options, clientIp: undefined });
  return {
    endpoint,
    ready: endpoint.ready(),
    keepAlive: true,
    admin: endpoint.admin,
    shutdown: livething.shutdown,
  };
});

type RouteHooks = { __websocket__?: object };

const app = createApp();
const router = createRouter();
router.use('/**', (event) => handleFetchRequest(toWebRequest(event)));
app.use(router);

// H3 v1 finds a WebSocket route by URL and uses the route handler's hooks. The
// fixtures are chosen per path and room, so this does the same lookup per request.
const websocket = nodeWebSocketAdapter({
  async resolve(info) {
    const { request, url: peerUrl } = info as { request?: { url?: string }; url?: string };
    const url = new URL(request?.url ?? peerUrl ?? '/', 'http://localhost');
    const room = url.searchParams.get('room') ?? 'default';
    try {
      const fixture = await getFixture(url.pathname, room);
      const endpoint = fixture.service.endpoint as H3V1Endpoint<unknown>;
      return (endpoint.upgrade as RouteHooks).__websocket__ ?? {};
    } catch {
      // Empty hooks would make crossws accept the socket, so refuse it the way
      // the other e2e servers refuse an unknown path.
      return { upgrade: () => new Response('Not Found', { status: 404 }) };
    }
  },
});

const port = Number(process.env.LIVETHING_E2E_SERVER_PORT ?? 8787);
const server = createServer(toNodeListener(app));
server.on('upgrade', websocket.handleUpgrade);
server.listen(port, '127.0.0.1');
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
console.log(`LiveThing H3 v1 e2e server listening on 127.0.0.1:${port}`);
