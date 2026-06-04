import { server } from '@wskit/server-cloudflare';
import { ctxSendHandler } from '@wskit/tests-e2e-handlers/ctx-send';

export const CtxSendServer = server(ctxSendHandler);
