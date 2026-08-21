import { server } from '@wskit/server-cloudflare';
import { inboxDynamicHandler } from '@wskit/tests-e2e-handlers/inbox-dynamic';

export class InboxDynamicServer extends server(inboxDynamicHandler) {}
