import { server } from '@wskit/server-cloudflare';
import { replayCustomHandler } from '@wskit/tests-e2e-handlers/replay-custom';

export class ReplayCustomServer extends server(replayCustomHandler) {}
