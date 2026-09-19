import { bind } from '@livething/server-cloudflare';
import { serverRequestDefinition } from '@livething/tests-e2e-handlers/server-request';

export class ServerRequestServer extends bind(serverRequestDefinition) {}
