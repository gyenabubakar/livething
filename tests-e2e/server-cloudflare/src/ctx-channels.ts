import { bind } from '@wskit/server-cloudflare';
import { ctxChannelsHandler } from '@wskit/tests-e2e-handlers/ctx-channels';

export class CtxChannelsServer extends bind(ctxChannelsHandler) {}
