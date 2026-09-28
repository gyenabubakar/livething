import { bind } from '@livething/server-cloudflare';
import { heartbeatDefinition } from '@livething/tests-e2e-handlers/heartbeat';

export class HeartbeatServer extends bind(heartbeatDefinition) {}
