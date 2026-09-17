import { bind } from '@wskit/server-cloudflare';
import { inboxDefinition } from '@wskit/tests-e2e-handlers/inbox';

export class InboxServer extends bind(inboxDefinition) {}
