import { streamBroadcastDefinition } from '@livething/tests-e2e-handlers/stream-broadcast';
import { bindFixture } from './bind-fixture.ts';

export class StreamBroadcastServer extends bindFixture(streamBroadcastDefinition) {}
