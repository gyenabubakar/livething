import { bind } from '@livething/server-cloudflare';
import { ctxTagsDefinition } from '@livething/tests-e2e-handlers/ctx-tags';

export class CtxTagsServer extends bind(ctxTagsDefinition) {}
