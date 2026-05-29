import { serve } from '@wskit/server-cloudflare';
import { keepaliveHandler } from './handler.ts';

export const KeepaliveServer = serve(keepaliveHandler);
