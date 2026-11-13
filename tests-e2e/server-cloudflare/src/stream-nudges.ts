import { streamNudgesDefinition } from '@livething/tests-e2e-handlers/stream-nudges';
import { bindFixture } from './bind-fixture.ts';

export class StreamNudgesServer extends bindFixture(streamNudgesDefinition) {}
