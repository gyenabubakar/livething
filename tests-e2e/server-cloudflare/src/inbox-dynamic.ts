import { bind } from '@wskit/server-cloudflare';
import { inboxDynamicDefinition } from '@wskit/tests-e2e-handlers/inbox-dynamic';

export class InboxDynamicServer extends bind(inboxDynamicDefinition) {}
