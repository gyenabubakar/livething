import { bind } from '@livething/server-cloudflare';
import { incomingDefinition } from '@livething/tests-e2e-handlers/incoming';

export class IncomingServer extends bind(incomingDefinition) {}
