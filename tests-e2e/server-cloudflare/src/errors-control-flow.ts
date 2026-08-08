import { server } from '@wskit/server-cloudflare';
import { errorsControlFlowHandler } from '@wskit/tests-e2e-handlers/errors-control-flow';

export class ErrorsControlFlowServer extends server(errorsControlFlowHandler) {}
