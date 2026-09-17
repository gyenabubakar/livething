import { bind } from '@wskit/server-cloudflare';
import { interceptHandler } from '@wskit/tests-e2e-handlers/intercept';

export class InterceptServer extends bind(interceptHandler) {}
