import { streamBackpressureDefinition } from '@livething/tests-e2e-handlers/stream-backpressure';
import { bindFixture } from './bind-fixture.ts';

export class StreamBackpressureServer extends bindFixture(streamBackpressureDefinition) {}
