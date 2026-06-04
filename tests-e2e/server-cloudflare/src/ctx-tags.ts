import { server } from '@wskit/server-cloudflare';
import { ctxTagsHandler } from '@wskit/tests-e2e-handlers/ctx-tags';

export const CtxTagsServer = server(ctxTagsHandler);
