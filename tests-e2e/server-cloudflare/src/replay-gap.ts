import { bind } from '@livething/server-cloudflare';
import { replayGapDefinition } from '@livething/tests-e2e-handlers/replay-gap';

export class ReplayGapServer extends bind(replayGapDefinition) {}
