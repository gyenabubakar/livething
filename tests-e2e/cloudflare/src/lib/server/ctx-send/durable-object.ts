import { server } from '@wskit/server-cloudflare';
import { ctxSendHandler } from './handler.ts';

export const CtxSendServer = server(ctxSendHandler);
