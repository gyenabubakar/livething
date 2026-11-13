import { heartbeatKeepaliveDefinition } from '@livething/tests-e2e-handlers/heartbeat-keepalive';
import { bindFixture } from './bind-fixture.ts';

export class HeartbeatKeepaliveServer extends bindFixture(heartbeatKeepaliveDefinition) {}
