import { bind } from '@livething/server-cloudflare';
import { interceptDefinition } from '@livething/tests-e2e-handlers/intercept';

export class InterceptServer extends bind(interceptDefinition) {}
