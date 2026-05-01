import { serve } from '@wskit/server-cloudflare';
import { channelScopeIsolationHandler } from './handler.ts';

export const ChannelScopeIsolationServer = serve(channelScopeIsolationHandler);
