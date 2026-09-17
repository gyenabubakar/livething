import { bind } from '@wskit/server-cloudflare';
import { keepaliveHandler } from '@wskit/tests-e2e-handlers/keepalive';

export class KeepaliveServer extends bind(keepaliveHandler) {}
