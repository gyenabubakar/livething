import { serve } from '@wskit/server-cloudflare';
import { streamDurableBroadcastHandler } from './handler.ts';

export const StreamDurableBroadcastServer = serve(streamDurableBroadcastHandler);
