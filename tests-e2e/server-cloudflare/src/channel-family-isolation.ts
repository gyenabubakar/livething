import { bind } from '@livething/server-cloudflare';
import { channelFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/channel-family-isolation';

export class ChannelFamilyIsolationServer extends bind(channelFamilyIsolationDefinition) {}
