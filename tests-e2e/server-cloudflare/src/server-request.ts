import { bind } from '@wskit/server-cloudflare';
import { serverRequestHandler } from '@wskit/tests-e2e-handlers/server-request';

export class ServerRequestServer extends bind(serverRequestHandler) {}
