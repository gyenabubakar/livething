import { bind } from '@wskit/server-cloudflare';
import { replayCustomDefinition } from '@wskit/tests-e2e-handlers/replay-custom';

export class ReplayCustomServer extends bind(replayCustomDefinition) {}
