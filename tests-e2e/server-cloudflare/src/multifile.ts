import { multifileDefinition } from '@livething/tests-e2e-handlers/multifile';
import { bindFixture } from './bind-fixture.ts';

export class MultifileServer extends bindFixture(multifileDefinition) {}
