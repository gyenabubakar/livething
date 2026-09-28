import { bind } from '@livething/server-cloudflare';
import { streamBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-broadcast';

export class StreamBroadcastServer extends bind(streamBroadcastDefinition) {}
