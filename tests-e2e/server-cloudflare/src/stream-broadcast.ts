import { bind } from '@wskit/server-cloudflare';
import { streamBroadcastDefinition } from '@wskit/tests-e2e-handlers/stream-broadcast';

export class StreamBroadcastServer extends bind(streamBroadcastDefinition) {}
