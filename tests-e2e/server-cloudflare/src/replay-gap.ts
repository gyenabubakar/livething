import { replayGapDefinition } from '@livething/tests-e2e-handlers/replay-gap';
import { bindFixture } from './bind-fixture.ts';

export class ReplayGapServer extends bindFixture(replayGapDefinition) {}
