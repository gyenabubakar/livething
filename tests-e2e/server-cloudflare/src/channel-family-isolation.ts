import { channelFamilyIsolationDefinition } from '@livething/tests-e2e-handlers/channel-family-isolation';
import { bindFixture } from './bind-fixture.ts';

export class ChannelFamilyIsolationServer extends bindFixture(channelFamilyIsolationDefinition) {}
