import { bind } from '@wskit/server-cloudflare';
import { channelKeyCollisionDefinition } from '@wskit/tests-e2e-handlers/channel-key-collision';

export class ChannelKeyCollisionServer extends bind(channelKeyCollisionDefinition) {}
