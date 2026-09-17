import { bind } from '@wskit/server-cloudflare';
import { ctxKvDefinition } from '@wskit/tests-e2e-handlers/ctx-kv';

export class CtxKvServer extends bind(ctxKvDefinition) {}
