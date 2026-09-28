import { bind } from '@livething/server-cloudflare';
import { keepaliveDefinition } from '@livething/tests-e2e-handlers/keepalive';

export class KeepaliveServer extends bind(keepaliveDefinition) {}
