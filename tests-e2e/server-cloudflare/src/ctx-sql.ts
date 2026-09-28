import { bind } from '@livething/server-cloudflare';
import { ctxSqlDefinition } from '@livething/tests-e2e-handlers/ctx-sql';

export class CtxSqlServer extends bind(ctxSqlDefinition) {}
