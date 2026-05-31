import { server } from '@wskit/server-cloudflare';
import { errorsControlFlowHandler } from './handler.ts';

export const ErrorsControlFlowServer = server(errorsControlFlowHandler);
