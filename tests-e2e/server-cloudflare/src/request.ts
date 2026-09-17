import { bind } from '@wskit/server-cloudflare';
import { requestDefinition } from '@wskit/tests-e2e-handlers/request';

export class RequestServer extends bind(requestDefinition) {}
