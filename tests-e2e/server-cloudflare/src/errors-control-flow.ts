import { errorsControlFlowDefinition } from '@livething/tests-e2e-handlers/errors-control-flow';
import { bindFixture } from './bind-fixture.ts';

export class ErrorsControlFlowServer extends bindFixture(errorsControlFlowDefinition) {}
