import { streamDurableScopedDefinition } from '@livething/tests-e2e-handlers/stream-durable-scoped';
import { bindFixture } from './bind-fixture.ts';

export class StreamDurableScopedServer extends bindFixture(streamDurableScopedDefinition) {}
