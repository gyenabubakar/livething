import { server } from '@wskit/server-cloudflare';
import { replayCustomCascadeHandler } from '@wskit/tests-e2e-handlers/replay-custom-cascade';

export const ReplayCustomCascadeServer = server(replayCustomCascadeHandler);
