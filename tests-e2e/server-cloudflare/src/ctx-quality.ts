import { bind } from '@wskit/server-cloudflare';
import { ctxQualityHandler } from '@wskit/tests-e2e-handlers/ctx-quality';

export class CtxQualityServer extends bind(ctxQualityHandler) {}
