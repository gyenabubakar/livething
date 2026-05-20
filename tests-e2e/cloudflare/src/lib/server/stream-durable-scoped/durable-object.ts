import { serve } from '@wskit/server-cloudflare';
import { streamDurableScopedHandler } from './handler.ts';

export const StreamDurableScopedServer = serve(streamDurableScopedHandler);
