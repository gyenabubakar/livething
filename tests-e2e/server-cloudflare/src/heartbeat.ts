import { heartbeatDefinition } from '@livething/tests-e2e-handlers/heartbeat';
import { bindFixture } from './bind-fixture.ts';

export class HeartbeatServer extends bindFixture(heartbeatDefinition) {}
