import { server } from '@wskit/server-cloudflare';
import { channelKeyCollisionHandler } from './handler.ts';

export const ChannelKeyCollisionServer = server(channelKeyCollisionHandler);
