import { bind } from '@livething/server-cloudflare';
import { channelStaticDefinition } from '@livething/tests-e2e-handlers/channel-static';

export class ChannelStaticServer extends bind(channelStaticDefinition) {}
