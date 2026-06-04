import { server } from '@wskit/server-cloudflare';
import { rateLimitHandler } from '@wskit/tests-e2e-handlers/rate-limit';

export const RateLimitServer = server(rateLimitHandler);
