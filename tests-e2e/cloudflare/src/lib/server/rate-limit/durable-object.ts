import { serve } from '@wskit/server-cloudflare';
import { rateLimitHandler } from './handler.ts';

export const RateLimitServer = serve(rateLimitHandler);
