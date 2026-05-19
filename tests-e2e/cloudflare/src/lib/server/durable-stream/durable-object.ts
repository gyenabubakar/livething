import { serve } from '@wskit/server-cloudflare';
import { durableStreamHandler } from './handler.ts';

export const DurableStreamServer = serve(durableStreamHandler);
