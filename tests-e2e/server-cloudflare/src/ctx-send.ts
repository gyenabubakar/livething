import { bind } from '@livething/server-cloudflare';
import { ctxSendDefinition } from '@livething/tests-e2e-handlers/ctx-send';

export class CtxSendServer extends bind(ctxSendDefinition) {}
