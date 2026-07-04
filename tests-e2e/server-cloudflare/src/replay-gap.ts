import { server } from '@wskit/server-cloudflare';
import { replayGapHandler } from '@wskit/tests-e2e-handlers/replay-gap';

export const ReplayGapServer = server(replayGapHandler);
