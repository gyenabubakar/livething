import { server } from '@wskit/server-cloudflare';
import { ctxTagsHandler } from './handler.ts';

export const CtxTagsServer = server(ctxTagsHandler);
