import { streamBasicDefinition } from '@livething/tests-e2e-handlers/stream-basic';
import { bindFixture } from './bind-fixture.ts';

export class StreamBasicServer extends bindFixture(streamBasicDefinition) {}
