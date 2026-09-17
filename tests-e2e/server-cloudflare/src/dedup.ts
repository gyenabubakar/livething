import { bind } from '@wskit/server-cloudflare';
import { dedupDefinition } from '@wskit/tests-e2e-handlers/dedup';

export class DedupServer extends bind(dedupDefinition) {}
