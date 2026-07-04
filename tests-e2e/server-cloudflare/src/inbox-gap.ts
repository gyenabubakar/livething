import { server } from '@wskit/server-cloudflare';
import { inboxGapHandler } from '@wskit/tests-e2e-handlers/inbox-gap';

export const InboxGapServer = server(inboxGapHandler);
