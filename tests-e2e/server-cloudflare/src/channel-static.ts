import { server } from '@wskit/server-cloudflare';
import { channelStaticHandler } from '@wskit/tests-e2e-handlers/channel-static';

export const ChannelStaticServer = server(channelStaticHandler);
