import { serve } from '@wskit/server-cloudflare';
import { ctxLocalsHandler } from './handler.ts';

export const CtxLocalsServer = serve(ctxLocalsHandler);
