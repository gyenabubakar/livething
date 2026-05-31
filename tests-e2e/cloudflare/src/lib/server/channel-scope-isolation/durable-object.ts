import { server } from '@wskit/server-cloudflare';
import { channelScopeIsolationHandler } from './handler.ts';

export const ChannelScopeIsolationServer = server(channelScopeIsolationHandler);
