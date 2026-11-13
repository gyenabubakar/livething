import { ctxSqlDefinition } from '@livething/tests-e2e-handlers/ctx-sql';
import { bindFixture } from './bind-fixture.ts';

export class CtxSqlServer extends bindFixture(ctxSqlDefinition) {}
