import { bind } from '@livething/server-cloudflare';
import { inboxDynamicDefinition } from '@livething/tests-e2e-handlers/inbox-dynamic';

export class InboxDynamicServer extends bind(inboxDynamicDefinition) {}
