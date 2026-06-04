import { server } from '@wskit/server-cloudflare';
import { streamDurableHandler } from '@wskit/tests-e2e-handlers/stream-durable';

export const StreamDurableServer = server(streamDurableHandler);
