import { bind } from '@livething/server-cloudflare';
import { lastSeenDefinition } from '@livething/tests-e2e-handlers/last-seen';

export class LastSeenServer extends bind(lastSeenDefinition) {}
