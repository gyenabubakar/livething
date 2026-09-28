import { bind } from '@livething/server-cloudflare';
import { ctxKvDefinition } from '@livething/tests-e2e-handlers/ctx-kv';

export class CtxKvServer extends bind(ctxKvDefinition) {}
