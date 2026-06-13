import { server } from '@wskit/server-cloudflare';
import { channelKeyCollisionHandler } from '@wskit/tests-e2e-handlers/channel-key-collision';

export const ChannelKeyCollisionServer = server(channelKeyCollisionHandler);
