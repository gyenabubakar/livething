import { bind } from '@livething/server-cloudflare';
import { ctxQualityDefinition } from '@livething/tests-e2e-handlers/ctx-quality';

export class CtxQualityServer extends bind(ctxQualityDefinition) {}
