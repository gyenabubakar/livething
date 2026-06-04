import { server } from '@wskit/server-cloudflare';
import { replayMembershipGateHandler } from '@wskit/tests-e2e-handlers/replay-membership-gate';

export const ReplayMembershipGateServer = server(replayMembershipGateHandler);
