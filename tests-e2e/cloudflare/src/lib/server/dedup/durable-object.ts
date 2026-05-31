import { server } from '@wskit/server-cloudflare';
import { dedupHandler } from './handler.ts';

export const DedupServer = server(dedupHandler);
