import { ctxLocalsDefinition } from '@livething/tests-e2e-handlers/ctx-locals';
import { bindFixture } from './bind-fixture.ts';

export class CtxLocalsServer extends bindFixture(ctxLocalsDefinition) {}
