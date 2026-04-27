import { serve } from '@wskit/server-cloudflare';
import { ctxChannelsHandler } from './handler.ts';

export const CtxChannelsServer = serve(ctxChannelsHandler);
