import { requestDefinition } from '@livething/tests-e2e-handlers/request';
import { bindFixture } from './bind-fixture.ts';

export class RequestServer extends bindFixture(requestDefinition) {}
