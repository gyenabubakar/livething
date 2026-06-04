import { server } from '@wskit/server-cloudflare';
import { channelDynamicHandler } from '@wskit/tests-e2e-handlers/channel-dynamic';

export const ChannelDynamicServer = server(channelDynamicHandler);
