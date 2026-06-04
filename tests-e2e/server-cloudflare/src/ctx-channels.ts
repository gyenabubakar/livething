import { server } from '@wskit/server-cloudflare';
import { ctxChannelsHandler } from '@wskit/tests-e2e-handlers/ctx-channels';

export const CtxChannelsServer = server(ctxChannelsHandler);
