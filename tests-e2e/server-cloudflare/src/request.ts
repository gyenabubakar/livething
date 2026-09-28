import { bind } from '@livething/server-cloudflare';
import { requestDefinition } from '@livething/tests-e2e-handlers/request';

export class RequestServer extends bind(requestDefinition) {}
