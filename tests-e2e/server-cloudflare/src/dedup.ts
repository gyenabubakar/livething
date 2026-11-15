import { dedupDefinition } from '@livething/tests-e2e-handlers/dedup';
import { bindFixture } from './bind-fixture.ts';

export class DedupServer extends bindFixture(dedupDefinition) {}
