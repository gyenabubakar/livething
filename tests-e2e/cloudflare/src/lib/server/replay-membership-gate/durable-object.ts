import { serve } from '@wskit/server-cloudflare';
import { replayMembershipGateHandler } from './handler.ts';

export const ReplayMembershipGateServer = serve(replayMembershipGateHandler);
