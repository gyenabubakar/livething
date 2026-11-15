import { errorHookIsolationDefinition } from '@livething/tests-e2e-handlers/error-hook-isolation';
import { bindFixture } from './bind-fixture.ts';

export class ErrorHookIsolationServer extends bindFixture(errorHookIsolationDefinition) {}
