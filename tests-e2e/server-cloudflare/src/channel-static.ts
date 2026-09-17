import { bind } from '@wskit/server-cloudflare';
import { channelStaticHandler } from '@wskit/tests-e2e-handlers/channel-static';

export class ChannelStaticServer extends bind(channelStaticHandler) {}
