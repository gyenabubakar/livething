import { server } from '@wskit/server-cloudflare';
import { ctxChannelsHandler } from './handler.ts';

export const CtxChannelsServer = server(ctxChannelsHandler);
