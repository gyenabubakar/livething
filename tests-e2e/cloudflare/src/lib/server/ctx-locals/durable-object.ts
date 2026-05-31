import { server } from '@wskit/server-cloudflare';
import { ctxLocalsHandler } from './handler.ts';

export const CtxLocalsServer = server(ctxLocalsHandler);
