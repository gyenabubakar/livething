import { ctxMetaDefinition } from '@livething/tests-e2e-handlers/ctx-meta';
import { bindFixture } from './bind-fixture.ts';

export class CtxMetaServer extends bindFixture(ctxMetaDefinition) {}
