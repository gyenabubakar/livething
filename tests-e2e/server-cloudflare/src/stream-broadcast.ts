import { server } from '@wskit/server-cloudflare';
import { streamBroadcastHandler } from '@wskit/tests-e2e-handlers/stream-broadcast';

export class StreamBroadcastServer extends server(streamBroadcastHandler) {}
