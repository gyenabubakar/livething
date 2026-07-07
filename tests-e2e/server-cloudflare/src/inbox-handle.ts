import { server } from '@wskit/server-cloudflare';
import { inboxHandleHandler } from '@wskit/tests-e2e-handlers/inbox-handle';

export const InboxHandleServer = server(inboxHandleHandler);
