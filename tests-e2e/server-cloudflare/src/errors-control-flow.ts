import { bind } from '@wskit/server-cloudflare';
import { errorsControlFlowDefinition } from '@wskit/tests-e2e-handlers/errors-control-flow';

export class ErrorsControlFlowServer extends bind(errorsControlFlowDefinition) {}
