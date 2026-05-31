import { server } from '@wskit/server-cloudflare';
import { streamDurableHandler } from './handler.ts';

export const StreamDurableServer = server(streamDurableHandler);
