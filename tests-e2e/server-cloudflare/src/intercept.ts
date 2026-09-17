import { bind } from '@wskit/server-cloudflare';
import { interceptDefinition } from '@wskit/tests-e2e-handlers/intercept';

export class InterceptServer extends bind(interceptDefinition) {}
