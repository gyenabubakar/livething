import { server } from '@wskit/server-cloudflare';
import { streamBroadcastHandler } from './handler.ts';

export const StreamBroadcastServer = server(streamBroadcastHandler);
