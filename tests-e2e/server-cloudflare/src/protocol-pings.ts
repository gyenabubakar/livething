import { protocolPingsDefinition } from '@livething/tests-e2e-handlers/protocol-pings';
import { bindFixture } from './bind-fixture.ts';

export class ProtocolPingsServer extends bindFixture(protocolPingsDefinition) {}
