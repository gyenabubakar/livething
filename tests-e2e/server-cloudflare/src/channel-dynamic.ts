import { bind } from '@wskit/server-cloudflare';
import { channelDynamicDefinition } from '@wskit/tests-e2e-handlers/channel-dynamic';

export class ChannelDynamicServer extends bind(channelDynamicDefinition) {}
