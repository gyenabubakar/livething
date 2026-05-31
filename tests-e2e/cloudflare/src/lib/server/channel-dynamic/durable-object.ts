import { server } from '@wskit/server-cloudflare';
import { channelDynamicHandler } from './handler.ts';

export const ChannelDynamicServer = server(channelDynamicHandler);
