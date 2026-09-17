import { bind } from '@wskit/server-cloudflare';
import { replayDefinition } from '@wskit/tests-e2e-handlers/replay-history';

export class ReplayServer extends bind(replayDefinition) {}
