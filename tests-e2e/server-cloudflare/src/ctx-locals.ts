import { bind } from '@wskit/server-cloudflare';
import { ctxLocalsHandler } from '@wskit/tests-e2e-handlers/ctx-locals';

export class CtxLocalsServer extends bind(ctxLocalsHandler) {}
