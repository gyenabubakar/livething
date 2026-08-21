import { server } from '@wskit/server-cloudflare';
import { lastSeenHandler } from '@wskit/tests-e2e-handlers/last-seen';

export class LastSeenServer extends server(lastSeenHandler) {}
