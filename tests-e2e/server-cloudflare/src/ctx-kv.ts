import { ctxKvDefinition } from '@livething/tests-e2e-handlers/ctx-kv';
import { bindFixture } from './bind-fixture.ts';

export class CtxKvServer extends bindFixture(ctxKvDefinition) {}
