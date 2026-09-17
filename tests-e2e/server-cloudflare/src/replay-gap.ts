import { bind } from '@wskit/server-cloudflare';
import { replayGapDefinition } from '@wskit/tests-e2e-handlers/replay-gap';

export class ReplayGapServer extends bind(replayGapDefinition) {}
