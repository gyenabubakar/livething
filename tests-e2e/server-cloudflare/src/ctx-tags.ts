import { bind } from '@wskit/server-cloudflare';
import { ctxTagsDefinition } from '@wskit/tests-e2e-handlers/ctx-tags';

export class CtxTagsServer extends bind(ctxTagsDefinition) {}
