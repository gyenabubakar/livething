import { bind } from '@livething/server-cloudflare';
import { inboxDefinition } from '@livething/tests-e2e-handlers/inbox';

export class InboxServer extends bind(inboxDefinition) {}
