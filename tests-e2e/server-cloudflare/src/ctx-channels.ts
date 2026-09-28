import { bind } from '@livething/server-cloudflare';
import { ctxChannelsDefinition } from '@livething/tests-e2e-handlers/ctx-channels';

export class CtxChannelsServer extends bind(ctxChannelsDefinition) {}
