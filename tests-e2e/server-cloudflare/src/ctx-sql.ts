import { bind } from '@wskit/server-cloudflare';
import { ctxSqlDefinition } from '@wskit/tests-e2e-handlers/ctx-sql';

export class CtxSqlServer extends bind(ctxSqlDefinition) {}
