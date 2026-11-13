import { incomingDefinition } from '@livething/tests-e2e-handlers/incoming';
import { bindFixture } from './bind-fixture.ts';

export class IncomingServer extends bindFixture(incomingDefinition) {}
