import { serve } from '@wskit/server-cloudflare';
import { ctxQualityHandler } from './handler.ts';

export const CtxQualityServer = serve(ctxQualityHandler, { hibernation: false });
