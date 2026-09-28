import { bind } from '@livething/server-cloudflare';
import { inboxHandleDefinition } from '@livething/tests-e2e-handlers/inbox-handle';

export class InboxHandleServer extends bind(inboxHandleDefinition) {}
