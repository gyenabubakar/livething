import { server } from '@wskit/server-cloudflare';
import { ctxLocalsHandler } from '@wskit/tests-e2e-handlers/ctx-locals';

export const CtxLocalsServer = server(ctxLocalsHandler);
