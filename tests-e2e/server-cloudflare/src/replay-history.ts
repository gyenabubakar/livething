import { server } from '@wskit/server-cloudflare';
import { replayHandler } from '@wskit/tests-e2e-handlers/replay-history';

export class ReplayServer extends server(replayHandler) {}
