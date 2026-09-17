import { bind } from '@wskit/server-cloudflare';
import { incomingDefinition } from '@wskit/tests-e2e-handlers/incoming';

export class IncomingServer extends bind(incomingDefinition) {}
