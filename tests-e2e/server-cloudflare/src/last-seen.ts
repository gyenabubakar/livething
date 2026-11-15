import { lastSeenDefinition } from '@livething/tests-e2e-handlers/last-seen';
import { bindFixture } from './bind-fixture.ts';

export class LastSeenServer extends bindFixture(lastSeenDefinition) {}
