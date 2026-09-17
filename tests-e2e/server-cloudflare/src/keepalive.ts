import { bind } from '@wskit/server-cloudflare';
import { keepaliveDefinition } from '@wskit/tests-e2e-handlers/keepalive';

export class KeepaliveServer extends bind(keepaliveDefinition) {}
