import { serve } from '@wskit/server-cloudflare';
import { channelKeyCollisionHandler } from './handler.ts';

export const ChannelKeyCollisionServer = serve(channelKeyCollisionHandler);
