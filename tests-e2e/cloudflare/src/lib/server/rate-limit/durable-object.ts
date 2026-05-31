import { server } from '@wskit/server-cloudflare';
import { rateLimitHandler } from './handler.ts';

export const RateLimitServer = server(rateLimitHandler);
