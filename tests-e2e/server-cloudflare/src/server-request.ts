import { server } from '@wskit/server-cloudflare';
import { serverRequestHandler } from '@wskit/tests-e2e-handlers/server-request';

export const ServerRequestServer = server(serverRequestHandler);
