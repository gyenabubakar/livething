import { bind } from '@livething/server-cloudflare';
import { ctxMetaDefinition } from '@livething/tests-e2e-handlers/ctx-meta';

export class CtxMetaServer extends bind(ctxMetaDefinition) {}
