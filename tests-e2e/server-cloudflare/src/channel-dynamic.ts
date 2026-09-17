import { bind } from '@wskit/server-cloudflare';
import { channelDynamicHandler } from '@wskit/tests-e2e-handlers/channel-dynamic';

export class ChannelDynamicServer extends bind(channelDynamicHandler) {}
