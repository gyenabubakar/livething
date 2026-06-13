import { server } from '@wskit/server-cloudflare';
import { ctxQualityHandler } from '@wskit/tests-e2e-handlers/ctx-quality';

export const CtxQualityServer = server(ctxQualityHandler);
