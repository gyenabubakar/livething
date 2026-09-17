import { bind } from '@wskit/server-cloudflare';
import { inboxHandleHandler } from '@wskit/tests-e2e-handlers/inbox-handle';

export class InboxHandleServer extends bind(inboxHandleHandler) {}
