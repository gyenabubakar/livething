import { channelCheckCommitDefinition } from '@livething/tests-e2e-handlers/channel-check-commit';
import { bindFixture } from './bind-fixture.ts';

export class ChannelCheckCommitServer extends bindFixture(channelCheckCommitDefinition) {}
