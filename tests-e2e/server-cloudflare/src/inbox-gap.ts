import { bind } from '@wskit/server-cloudflare';
import { inboxGapHandler } from '@wskit/tests-e2e-handlers/inbox-gap';

export class InboxGapServer extends bind(inboxGapHandler) {}
