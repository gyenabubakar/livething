import { server } from '@wskit/server-cloudflare';
import { dedupHandler } from '@wskit/tests-e2e-handlers/dedup';

export const DedupServer = server(dedupHandler);
