import { bind } from '@wskit/server-cloudflare';
import { dedupHandler } from '@wskit/tests-e2e-handlers/dedup';

export class DedupServer extends bind(dedupHandler) {}
