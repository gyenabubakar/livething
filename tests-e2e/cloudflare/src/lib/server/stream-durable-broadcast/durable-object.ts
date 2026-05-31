import { server } from '@wskit/server-cloudflare';
import { streamDurableBroadcastHandler } from './handler.ts';

export const StreamDurableBroadcastServer = server(streamDurableBroadcastHandler);
