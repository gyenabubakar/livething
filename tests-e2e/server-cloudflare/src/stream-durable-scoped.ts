import { bind } from '@wskit/server-cloudflare';
import { streamDurableScopedDefinition } from '@wskit/tests-e2e-handlers/stream-durable-scoped';

export class StreamDurableScopedServer extends bind(streamDurableScopedDefinition) {}
