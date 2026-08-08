import { server } from '@wskit/server-cloudflare';
import { channelFamilyIsolationHandler } from '@wskit/tests-e2e-handlers/channel-family-isolation';

export class ChannelFamilyIsolationServer extends server(channelFamilyIsolationHandler) {}
