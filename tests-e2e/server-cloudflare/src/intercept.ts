import { interceptDefinition } from '@livething/tests-e2e-handlers/intercept';
import { bindFixture } from './bind-fixture.ts';

export class InterceptServer extends bindFixture(interceptDefinition) {}
