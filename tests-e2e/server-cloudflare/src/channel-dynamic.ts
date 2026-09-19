import { bind } from '@livething/server-cloudflare';
import { channelDynamicDefinition } from '@livething/tests-e2e-handlers/channel-dynamic';

export class ChannelDynamicServer extends bind(channelDynamicDefinition) {}
