import { bind } from '@wskit/server-cloudflare';
import { rateLimitHandler } from '@wskit/tests-e2e-handlers/rate-limit';

export class RateLimitServer extends bind(rateLimitHandler) {}
