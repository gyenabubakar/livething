import { server } from '@wskit/server-cloudflare';
import { streamDurableScopedHandler } from '@wskit/tests-e2e-handlers/stream-durable-scoped';

export const StreamDurableScopedServer = server(streamDurableScopedHandler);
