import { server } from '@wskit/server-cloudflare';
import { ctxKvHandler } from '@wskit/tests-e2e-handlers/ctx-kv';

export const CtxKvServer = server(ctxKvHandler);
