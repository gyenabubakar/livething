import { ctxSendDefinition } from '@livething/tests-e2e-handlers/ctx-send';
import { bindFixture } from './bind-fixture.ts';

export class CtxSendServer extends bindFixture(ctxSendDefinition) {}
