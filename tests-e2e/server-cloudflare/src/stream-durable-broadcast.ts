import { streamDurableBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-durable-broadcast';
import { bindFixture } from './bind-fixture.ts';

export class StreamDurableBroadcastServer extends bindFixture(streamDurableBroadcastDefinition) {}
