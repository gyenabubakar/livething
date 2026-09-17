import { bind } from '@wskit/server-cloudflare';
import { channelCheckCommitHandler } from '@wskit/tests-e2e-handlers/channel-check-commit';

export class ChannelCheckCommitServer extends bind(channelCheckCommitHandler) {}
