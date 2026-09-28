import { bind } from '@livething/server-cloudflare';
import { rateLimitDefinition } from '@livething/tests-e2e-handlers/rate-limit';

export class RateLimitServer extends bind(rateLimitDefinition) {}
