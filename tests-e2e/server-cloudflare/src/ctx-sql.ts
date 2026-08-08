import { server } from '@wskit/server-cloudflare';
import { ctxSqlHandler } from '@wskit/tests-e2e-handlers/ctx-sql';

export class CtxSqlServer extends server(ctxSqlHandler) {}
