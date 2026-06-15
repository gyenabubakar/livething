import { server } from '@wskit/server-cloudflare';
import { serverAckHandler } from '@wskit/tests-e2e-handlers/server-ack';

export const ServerAckServer = server(serverAckHandler);
