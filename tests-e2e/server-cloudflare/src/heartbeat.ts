import { bind } from '@wskit/server-cloudflare';
import { heartbeatHandler } from '@wskit/tests-e2e-handlers/heartbeat';

export class HeartbeatServer extends bind(heartbeatHandler) {}
