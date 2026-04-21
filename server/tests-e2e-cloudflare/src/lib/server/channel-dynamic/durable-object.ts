import { serve } from '@wskit/server-cloudflare';
import { channelDynamicHandler } from './handler.ts';

export const ChannelDynamicServer = serve(channelDynamicHandler, { hibernation: false });
