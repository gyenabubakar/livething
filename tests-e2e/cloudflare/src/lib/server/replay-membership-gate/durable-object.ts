import { server } from '@wskit/server-cloudflare';
import { replayMembershipGateHandler } from './handler.ts';

export const ReplayMembershipGateServer = server(replayMembershipGateHandler);
