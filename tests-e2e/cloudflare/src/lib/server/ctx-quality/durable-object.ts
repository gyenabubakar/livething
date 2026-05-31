import { server } from '@wskit/server-cloudflare';
import { ctxQualityHandler } from './handler.ts';

export const CtxQualityServer = server(ctxQualityHandler);
