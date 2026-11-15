import { lifecycleHooksDefinition } from '@livething/tests-e2e-handlers/lifecycle-hooks';
import { bindFixture } from './bind-fixture.ts';

export class LifecycleHooksServer extends bindFixture(lifecycleHooksDefinition) {}
