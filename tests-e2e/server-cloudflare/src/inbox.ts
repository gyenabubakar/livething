import { server } from '@wskit/server-cloudflare';
import { inboxHandler } from '@wskit/tests-e2e-handlers/inbox';

export const InboxServer = server(inboxHandler);
