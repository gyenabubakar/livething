import { server } from '@wskit/server-cloudflare';
import { keepaliveHandler } from './handler.ts';

export const KeepaliveServer = server(keepaliveHandler);
