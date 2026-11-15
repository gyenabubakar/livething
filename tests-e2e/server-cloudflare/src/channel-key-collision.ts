import { channelKeyCollisionDefinition } from '@livething/tests-e2e-handlers/channel-key-collision';
import { bindFixture } from './bind-fixture.ts';

export class ChannelKeyCollisionServer extends bindFixture(channelKeyCollisionDefinition) {}
