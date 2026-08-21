import { server } from '@wskit/server-cloudflare';
import { streamDurableScopedHandler } from '@wskit/tests-e2e-handlers/stream-durable-scoped';

export class StreamDurableScopedServer extends server(streamDurableScopedHandler) {}
