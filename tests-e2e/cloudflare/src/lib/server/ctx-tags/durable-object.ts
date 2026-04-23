import { serve } from '@wskit/server-cloudflare';
import { ctxTagsHandler } from './handler.ts';

export const CtxTagsServer = serve(ctxTagsHandler, { hibernation: false });
