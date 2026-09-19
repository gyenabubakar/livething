import { bind } from '@livething/server-cloudflare';
import { channelKeyCollisionDefinition } from '@livething/tests-e2e-handlers/channel-key-collision';

export class ChannelKeyCollisionServer extends bind(channelKeyCollisionDefinition) {}
