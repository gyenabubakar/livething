import { server } from '@wskit/server-cloudflare';
import { keepaliveHandler } from '@wskit/tests-e2e-handlers/keepalive';

export const KeepaliveServer = server(keepaliveHandler);
