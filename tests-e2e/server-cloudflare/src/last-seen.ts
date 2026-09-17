import { bind } from '@wskit/server-cloudflare';
import { lastSeenDefinition } from '@wskit/tests-e2e-handlers/last-seen';

export class LastSeenServer extends bind(lastSeenDefinition) {}
