import { server } from '@wskit/server-cloudflare';
import { heartbeatKeepaliveHandler } from '@wskit/tests-e2e-handlers/heartbeat-keepalive';

export const HeartbeatKeepaliveServer = server(heartbeatKeepaliveHandler);
