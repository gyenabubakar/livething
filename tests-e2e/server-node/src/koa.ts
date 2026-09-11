import { createServer } from 'node:http';
import { setup } from '@wskit/server-node';
import Koa from 'koa';
import {
  attachUpgradeHandler,
  configureFixtureBinding,
  handleRequest,
  listen,
} from './node-http.ts';

configureFixtureBinding((handler, options) => {
  const wskit = setup();
  const endpoint = wskit.bind(handler, options);
  return {
    endpoint,
    ready: endpoint.ready(),
    admin: endpoint.admin,
    shutdown: wskit.shutdown,
  };
});

const app = new Koa();
app.use(async (context) => {
  await handleRequest(context.req, context.res);
  context.respond = false;
});

const server = createServer(app.callback());
attachUpgradeHandler(server);
listen(server, 'Koa');
