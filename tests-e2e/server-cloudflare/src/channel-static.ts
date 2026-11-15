import { channelStaticDefinition } from '@livething/tests-e2e-handlers/channel-static';
import { bindFixture } from './bind-fixture.ts';

export class ChannelStaticServer extends bindFixture(channelStaticDefinition) {}
