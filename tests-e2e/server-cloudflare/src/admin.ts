import { adminDefinition } from '@livething/tests-e2e-handlers/admin';
import { bindFixture } from './bind-fixture.ts';

export class AdminServer extends bindFixture(adminDefinition) {}
