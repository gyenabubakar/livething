import { bind } from '@wskit/server-cloudflare';
import { streamDurableBroadcastDefinition } from '@wskit/tests-e2e-handlers/stream-durable-broadcast';

export class StreamDurableBroadcastServer extends bind(streamDurableBroadcastDefinition) {}
