import { server } from '@wskit/server-cloudflare';
import { streamDurableScopedHandler } from './handler.ts';

export const StreamDurableScopedServer = server(streamDurableScopedHandler);
