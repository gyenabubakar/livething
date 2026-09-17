import { bind } from '@wskit/server-cloudflare';
import { ctxSendDefinition } from '@wskit/tests-e2e-handlers/ctx-send';

export class CtxSendServer extends bind(ctxSendDefinition) {}
