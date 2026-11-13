import { channelDynamicDefinition } from '@livething/tests-e2e-handlers/channel-dynamic';
import { bindFixture } from './bind-fixture.ts';

export class ChannelDynamicServer extends bindFixture(channelDynamicDefinition) {}
