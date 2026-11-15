import { replayDefinition } from '@livething/tests-e2e-handlers/replay-history';
import { bindFixture } from './bind-fixture.ts';

export class ReplayServer extends bindFixture(replayDefinition) {}
