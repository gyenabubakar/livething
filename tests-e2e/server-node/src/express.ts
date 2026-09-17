import { createServer } from 'node:http';
import { setup } from '@wskit/server-node';
import express from 'express';
import {
  attachUpgradeHandler,
  configureFixtureBinding,
  handleRequest,
  listen,
} from './node-http.ts';

configureFixtureBinding((definition, options) => {
  const wskit = setup();
  const endpoint = wskit.bind(definition, options);
  return {
    endpoint,
    ready: endpoint.ready(),
    admin: endpoint.admin,
    shutdown: wskit.shutdown,
  };
});

const app = express();
app.use((request, response) => {
  void handleRequest(request, response);
});

const server = createServer(app);
attachUpgradeHandler(server);
listen(server, 'Express');
