import { server } from '@wskit/server-cloudflare';
import { ctxMetaHandler } from '@wskit/tests-e2e-handlers/ctx-meta';

export class CtxMetaServer extends server(ctxMetaHandler) {}
