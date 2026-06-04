import { server } from '@wskit/server-cloudflare';
import { channelScopeIsolationHandler } from '@wskit/tests-e2e-handlers/channel-scope-isolation';

export const ChannelScopeIsolationServer = server(channelScopeIsolationHandler);
