import { serve } from '@wskit/server-cloudflare';
import { ctxSendHandler } from './handler.ts';

export const CtxSendServer = serve(ctxSendHandler, { hibernation: false });
