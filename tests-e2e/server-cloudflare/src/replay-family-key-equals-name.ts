import { replayFamilyKeyEqualsNameDefinition } from '@livething/tests-e2e-handlers/replay-family-key-equals-name';
import { bindFixture } from './bind-fixture.ts';

export class ReplayFamilyKeyEqualsNameServer extends bindFixture(
  replayFamilyKeyEqualsNameDefinition,
) {}
