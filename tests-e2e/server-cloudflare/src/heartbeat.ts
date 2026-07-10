import { server } from '@wskit/server-cloudflare';
import { heartbeatHandler } from '@wskit/tests-e2e-handlers/heartbeat';

export const HeartbeatServer = server(heartbeatHandler);
