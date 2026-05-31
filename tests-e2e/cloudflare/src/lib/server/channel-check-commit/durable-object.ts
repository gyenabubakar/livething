import { server } from '@wskit/server-cloudflare';
import { channelCheckCommitHandler } from './handler.ts';

export const ChannelCheckCommitServer = server(channelCheckCommitHandler);
