import { bind } from '@wskit/server-cloudflare';
import { streamDurableDefinition } from '@wskit/tests-e2e-handlers/stream-durable';

export class StreamDurableServer extends bind(streamDurableDefinition) {}
