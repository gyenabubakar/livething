import { replaySnapshotDefinition } from '@livething/tests-e2e-handlers/replay-snapshot';
import { bindFixture } from './bind-fixture.ts';

export class ReplaySnapshotServer extends bindFixture(replaySnapshotDefinition) {}
