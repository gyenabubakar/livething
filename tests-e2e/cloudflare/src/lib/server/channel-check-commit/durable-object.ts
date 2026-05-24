import { serve } from '@wskit/server-cloudflare';
import { channelCheckCommitHandler } from './handler.ts';

export const ChannelCheckCommitServer = serve(channelCheckCommitHandler);
