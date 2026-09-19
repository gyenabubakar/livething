import { bind } from '@livething/server-cloudflare';
import { streamDurableDefinition } from '@livething/tests-e2e-handlers/stream-durable';

export class StreamDurableServer extends bind(streamDurableDefinition) {}
