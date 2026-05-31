import { server } from '@wskit/server-cloudflare';
import { ctxKvHandler } from './handler.ts';

export const CtxKvServer = server(ctxKvHandler);
