import { server } from '@wskit/server-cloudflare';
import { multiStateHandler } from '@wskit/tests-e2e-handlers/multi-state';

export class MultiStateServer extends server(multiStateHandler) {}
