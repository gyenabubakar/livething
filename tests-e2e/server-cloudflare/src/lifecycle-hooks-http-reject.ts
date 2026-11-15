import { rejectHttpDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks-http-reject';
import { bindFixture } from './bind-fixture.ts';

export class RejectHttpServer extends bindFixture(rejectHttpDefinition) {}
