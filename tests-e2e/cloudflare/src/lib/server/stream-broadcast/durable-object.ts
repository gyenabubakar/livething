import { serve } from '@wskit/server-cloudflare';
import { streamBroadcastHandler } from './handler.ts';

export const StreamBroadcastServer = serve(streamBroadcastHandler, { hibernation: false });
