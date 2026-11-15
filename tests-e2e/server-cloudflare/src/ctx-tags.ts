import { ctxTagsDefinition } from '@livething/tests-e2e-handlers/ctx-tags';
import { bindFixture } from './bind-fixture.ts';

export class CtxTagsServer extends bindFixture(ctxTagsDefinition) {}
