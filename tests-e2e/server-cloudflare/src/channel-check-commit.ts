import { bind } from '@livething/server-cloudflare';
import { channelCheckCommitDefinition } from '@livething/tests-e2e-handlers/channel-check-commit';

export class ChannelCheckCommitServer extends bind(channelCheckCommitDefinition) {}
