import { server } from '@wskit/server-cloudflare';
import { broadcastRequestHandler } from '@wskit/tests-e2e-handlers/broadcast-request';

export const BroadcastRequestServer = server(broadcastRequestHandler);
