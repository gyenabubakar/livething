import { serve } from '@wskit/server-cloudflare';
import { ctxMetaHandler } from './handler.ts';

export const CtxMetaServer = serve(ctxMetaHandler, { hibernation: false });
