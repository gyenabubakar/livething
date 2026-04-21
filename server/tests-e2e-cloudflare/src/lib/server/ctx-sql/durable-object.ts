import { serve } from '@wskit/server-cloudflare';
import { ctxSqlHandler } from './handler.ts';

export const CtxSqlServer = serve(ctxSqlHandler, { hibernation: false });
