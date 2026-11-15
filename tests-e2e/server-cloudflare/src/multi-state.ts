import { multiStateDefinition } from '@livething/tests-e2e-handlers/multi-state';
import { bindFixture } from './bind-fixture.ts';

export class MultiStateServer extends bindFixture(multiStateDefinition) {}
