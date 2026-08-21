import { server } from '@wskit/server-cloudflare';
import { rateLimitHandler } from '@wskit/tests-e2e-handlers/rate-limit';

export class RateLimitServer extends server(rateLimitHandler) {}
