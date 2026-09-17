import { bind } from '@wskit/server-cloudflare';
import { channelFamilyIsolationDefinition } from '@wskit/tests-e2e-handlers/channel-family-isolation';

export class ChannelFamilyIsolationServer extends bind(channelFamilyIsolationDefinition) {}
