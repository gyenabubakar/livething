import { serve } from '@wskit/server-cloudflare';
import { streamDurableHandler } from './handler.ts';

export const StreamDurableServer = serve(streamDurableHandler);
