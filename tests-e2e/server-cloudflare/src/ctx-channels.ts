import { bind } from '@wskit/server-cloudflare';
import { ctxChannelsDefinition } from '@wskit/tests-e2e-handlers/ctx-channels';

export class CtxChannelsServer extends bind(ctxChannelsDefinition) {}
