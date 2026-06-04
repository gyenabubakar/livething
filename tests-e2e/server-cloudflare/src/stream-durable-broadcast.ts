import { server } from '@wskit/server-cloudflare';
import { streamDurableBroadcastHandler } from '@wskit/tests-e2e-handlers/stream-durable-broadcast';

export const StreamDurableBroadcastServer = server(streamDurableBroadcastHandler);
