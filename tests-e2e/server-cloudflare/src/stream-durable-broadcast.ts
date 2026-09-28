import { bind } from '@livething/server-cloudflare';
import { streamDurableBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-durable-broadcast';

export class StreamDurableBroadcastServer extends bind(streamDurableBroadcastDefinition) {}
