import { server } from '@wskit/server-cloudflare';
import { incomingHandler } from '@wskit/tests-e2e-handlers/incoming';

export const IncomingServer = server(incomingHandler);
