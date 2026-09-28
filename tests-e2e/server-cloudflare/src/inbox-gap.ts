import { bind } from '@livething/server-cloudflare';
import { inboxGapDefinition } from '@livething/tests-e2e-handlers/inbox-gap';

export class InboxGapServer extends bind(inboxGapDefinition) {}
