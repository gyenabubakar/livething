import { bind } from '@livething/server-cloudflare';
import { dedupDefinition } from '@livething/tests-e2e-handlers/dedup';

export class DedupServer extends bind(dedupDefinition) {}
