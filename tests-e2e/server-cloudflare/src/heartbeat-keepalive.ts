import { bind } from '@livething/server-cloudflare';
import { heartbeatKeepaliveDefinition } from '@livething/tests-e2e-handlers/heartbeat-keepalive';

export class HeartbeatKeepaliveServer extends bind(heartbeatKeepaliveDefinition) {}
