import { bind } from '@wskit/server-cloudflare';
import { replayGapHandler } from '@wskit/tests-e2e-handlers/replay-gap';

export class ReplayGapServer extends bind(replayGapHandler) {}
