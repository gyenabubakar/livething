import { server } from '@wskit/server-cloudflare';
import { inboxHandler } from '@wskit/tests-e2e-handlers/inbox';

export class InboxServer extends server(inboxHandler) {}
