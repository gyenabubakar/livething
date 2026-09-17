import { bind } from '@wskit/server-cloudflare';
import { rateLimitDefinition } from '@wskit/tests-e2e-handlers/rate-limit';

export class RateLimitServer extends bind(rateLimitDefinition) {}
