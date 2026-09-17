import { bind } from '@wskit/server-cloudflare';
import { channelStaticDefinition } from '@wskit/tests-e2e-handlers/channel-static';

export class ChannelStaticServer extends bind(channelStaticDefinition) {}
