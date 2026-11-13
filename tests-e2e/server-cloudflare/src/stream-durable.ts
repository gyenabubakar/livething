import { streamDurableDefinition } from '@livething/tests-e2e-handlers/stream-durable';
import { bindFixture } from './bind-fixture.ts';

export class StreamDurableServer extends bindFixture(streamDurableDefinition) {}
