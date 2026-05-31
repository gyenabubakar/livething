import { server } from '@wskit/server-cloudflare';
import { ctxSqlHandler } from './handler.ts';

export const CtxSqlServer = server(ctxSqlHandler);
