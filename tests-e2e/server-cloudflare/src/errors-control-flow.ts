import { bind } from '@livething/server-cloudflare';
import { errorsControlFlowDefinition } from '@livething/tests-e2e-handlers/errors-control-flow';

export class ErrorsControlFlowServer extends bind(errorsControlFlowDefinition) {}
