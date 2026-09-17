import { bind } from '@wskit/server-cloudflare';
import { ctxMetaDefinition } from '@wskit/tests-e2e-handlers/ctx-meta';

export class CtxMetaServer extends bind(ctxMetaDefinition) {}
