import { server } from '@wskit/server-cloudflare';
import { ctxSqlHandler } from '@wskit/tests-e2e-handlers/ctx-sql';

export const CtxSqlServer = server(ctxSqlHandler);
