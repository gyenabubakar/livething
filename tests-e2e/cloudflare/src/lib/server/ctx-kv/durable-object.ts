import { serve } from '@wskit/server-cloudflare';
import { ctxKvHandler } from './handler.ts';

export const CtxKvServer = serve(ctxKvHandler);
