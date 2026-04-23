import { serve } from '@wskit/server-cloudflare';
import { errorsControlFlowHandler } from './handler.ts';

export const ErrorsControlFlowServer = serve(errorsControlFlowHandler, { hibernation: false });
