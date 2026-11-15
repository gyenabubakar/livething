import { ctxQualityDefinition } from '@livething/tests-e2e-handlers/ctx-quality';
import { bindFixture } from './bind-fixture.ts';

export class CtxQualityServer extends bindFixture(ctxQualityDefinition) {}
