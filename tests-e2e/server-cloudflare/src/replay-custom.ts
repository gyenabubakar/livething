import { server } from '@wskit/server-cloudflare';
import { replayCustomHandler } from '@wskit/tests-e2e-handlers/replay-custom';

export const ReplayCustomServer = server(replayCustomHandler);
