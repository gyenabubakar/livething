import { server } from '@wskit/server-cloudflare';
import { ackHandler } from '@wskit/tests-e2e-handlers/ack';

export const AckServer = server(ackHandler);
