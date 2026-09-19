import { bind } from '@livething/server-cloudflare';
import { streamDurableScopedDefinition } from '@livething/tests-e2e-handlers/stream-durable-scoped';

export class StreamDurableScopedServer extends bind(streamDurableScopedDefinition) {}
