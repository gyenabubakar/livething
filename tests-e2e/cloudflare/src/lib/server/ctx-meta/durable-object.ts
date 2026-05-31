import { server } from '@wskit/server-cloudflare';
import { ctxMetaHandler } from './handler.ts';

export const CtxMetaServer = server(ctxMetaHandler);
