import { bind } from '@wskit/server-cloudflare';
import { heartbeatKeepaliveDefinition } from '@wskit/tests-e2e-handlers/heartbeat-keepalive';

export class HeartbeatKeepaliveServer extends bind(heartbeatKeepaliveDefinition) {}
