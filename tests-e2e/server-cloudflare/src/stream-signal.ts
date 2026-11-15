import { streamSignalDefinition } from '@livething/tests-e2e-handlers/stream-signal';
import { bindFixture } from './bind-fixture.ts';

export class StreamSignalServer extends bindFixture(streamSignalDefinition) {}
