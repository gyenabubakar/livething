import { keepaliveDefinition } from '@livething/tests-e2e-handlers/keepalive';
import { bindFixture } from './bind-fixture.ts';

export class KeepaliveServer extends bindFixture(keepaliveDefinition) {}
