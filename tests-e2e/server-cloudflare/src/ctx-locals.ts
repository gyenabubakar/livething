import { bind } from '@livething/server-cloudflare';
import { ctxLocalsDefinition } from '@livething/tests-e2e-handlers/ctx-locals';

export class CtxLocalsServer extends bind(ctxLocalsDefinition) {}
