import { serve } from '@wskit/server-cloudflare';
import { channelStaticHandler } from './handler.ts';

export const ChannelStaticServer = serve(channelStaticHandler);
